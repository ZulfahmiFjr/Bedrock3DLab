import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

async function openSocket(path) {
    const response = await SELF.fetch(`https://relay.example.com${path}`, {
        headers: { Upgrade: "websocket" },
    });
    if (response.status !== 101 || !response.webSocket) {
        return { status: response.status, body: await response.json(), ws: null };
    }
    const ws = response.webSocket;
    const queue = [];
    const waiters = [];
    ws.addEventListener("message", (event) => {
        const payload = JSON.parse(event.data);
        if (waiters.length > 0) {
            waiters.shift()(payload);
        } else {
            queue.push(payload);
        }
    });
    ws.accept();
    const nextMessage = (timeoutMs = 2000) => {
        if (queue.length > 0) {
            return Promise.resolve(queue.shift());
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs);
            waiters.push((msg) => {
                clearTimeout(timer);
                resolve(msg);
            });
        });
    };
    const closePromise = new Promise((resolve) => {
        ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
    });
    return { status: 101, ws, nextMessage, closePromise };
}

describe("Bedrock3DLab Relay Worker", () => {
    it("serves metadata on / and /health with CORS headers", async () => {
        for (const path of ["/", "/health"]) {
            const response = await SELF.fetch(`https://relay.example.com${path}`);
            expect(response.status).toBe(200);
            expect(response.headers.get("access-control-allow-origin")).toBe("*");
            const body = await response.json();
            expect(body.ok).toBe(true);
            expect(body.protocolVersion).toBe(2);
            expect(body.messageTypes.pluginControl).toContain("relay.pair.create");
        }
    });

    it("enforces per-room secret claiming and rejects short or mismatched secrets", async () => {
        const shortSecret = await openSocket("/ws?role=plugin&serverId=srv_auth_test&secret=short");
        expect(shortSecret.status).toBe(401);

        const validSecret = "sec_1234567890abcdef1234567890ab";
        const owner = await openSocket(`/ws?role=plugin&serverId=srv_auth_test&secret=${validSecret}`);
        expect(owner.status).toBe(101);
        const ready = await owner.nextMessage();
        expect(ready.type).toBe("relay.ready");
        expect(ready.protocolVersion).toBe(2);

        const intruder = await openSocket("/ws?role=plugin&serverId=srv_auth_test&secret=wrong_secret_1234567890abcdef");
        expect(intruder.status).toBe(401);

        owner.ws.close(1000, "test done");
    });

    it("supports dynamic pairing, 2-way forwarding, and revocation", async () => {
        const serverId = "srv_e2e_room_01";
        const secret = "sec_e2e_secret_1234567890abcdef";

        const plugin = await openSocket(`/ws?role=plugin&serverId=${serverId}&secret=${secret}`);
        expect(plugin.status).toBe(101);
        const pluginReady = await plugin.nextMessage();
        expect(pluginReady.type).toBe("relay.ready");

        // bikin pair code dinamis langsung dari plugin
        plugin.ws.send(JSON.stringify({ type: "relay.pair.create", requestId: "pair_1", data: { ttlSeconds: 300 } }));
        const pairCreated = await plugin.nextMessage();
        expect(pairCreated.type).toBe("relay.pair.created");
        expect(pairCreated.requestId).toBe("pair_1");
        const pairCode = pairCreated.data.pairCode;
        expect(pairCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

        const badWeb = await openSocket(`/ws?role=web&serverId=${serverId}&pairCode=AAAA-BBBB`);
        expect(badWeb.status).toBe(401);

        // uji kode pairing tanpa tanda strip sama huruf kecil
        const normalizedAttempt = pairCode.replace("-", "").toLowerCase();
        const web = await openSocket(`/ws?role=web&serverId=${serverId}&pairCode=${normalizedAttempt}`);
        expect(web.status).toBe(101);

        const webReady = await web.nextMessage();
        expect(webReady.type).toBe("relay.ready");
        expect(webReady.data.pluginOnline).toBe(true);

        const webPeersNotice = await web.nextMessage();
        expect(webPeersNotice.type).toBe("web.peers");
        expect(webPeersNotice.data.webClients).toBe(1);

        const webConnectedNotice = await plugin.nextMessage();
        expect(webConnectedNotice.type).toBe("web.connected");

        // uji pesan web ke plugin
        web.ws.send(JSON.stringify({ type: "server.players.request", requestId: "req_players_1", data: {} }));
        const forwardedToPlugin = await plugin.nextMessage();
        expect(forwardedToPlugin.type).toBe("from.web");
        expect(forwardedToPlugin.message.type).toBe("server.players.request");

        // uji balasan plugin ke web
        plugin.ws.send(
            JSON.stringify({
                type: "server.players.response",
                requestId: "req_players_1",
                data: { players: [{ name: "Fajeray", uuid: "00000000-0000-0000-0000-000000000001", online: true }] },
            })
        );
        const forwardedToWeb = await web.nextMessage();
        expect(forwardedToWeb.type).toBe("from.plugin");
        expect(forwardedToWeb.message.data.players[0].name).toBe("Fajeray");

        // uji apply skin dari web ke plugin
        web.ws.send(
            JSON.stringify({
                type: "player.skin.apply",
                requestId: "req_apply_1",
                data: {
                    playerName: "Fajeray",
                    skinId: "custom_edited",
                    skinData: "AAAA",
                    geometryName: "geometry.humanoid.custom",
                    geometryData: "{}",
                },
            })
        );
        const applyMsg = await plugin.nextMessage();
        expect(applyMsg.type).toBe("from.web");
        expect(applyMsg.message.type).toBe("player.skin.apply");

        // uji revoke sesi pairing
        plugin.ws.send(JSON.stringify({ type: "relay.pair.revoke", requestId: "rev_1", data: {} }));
        const closeEvent = await web.closePromise;
        expect(closeEvent.code).toBe(4001);

        const revoked = await plugin.nextMessage();
        expect(revoked.type).toBe("relay.pair.revoked");
        expect(revoked.data.disconnectedWebClients).toBe(1);

        const reuseOldCode = await openSocket(`/ws?role=web&serverId=${serverId}&pairCode=${pairCode}`);
        expect(reuseOldCode.status).toBe(401);

        plugin.ws.close(1000, "test done");
    });

    it("broadcasts live bone sync, skin updates across web peers, and targets skin responses", async () => {
        const serverId = "srv_e2e_live_01";
        const secret = "sec_e2e_live_secret_1234567890abcd";

        const plugin = await openSocket(`/ws?role=plugin&serverId=${serverId}&secret=${secret}`);
        expect(plugin.status).toBe(101);
        await plugin.nextMessage();

        plugin.ws.send(JSON.stringify({ type: "relay.pair.create", requestId: "pair_live", data: { ttlSeconds: 300 } }));
        const pairCreated = await plugin.nextMessage();
        const pairCode = pairCreated.data.pairCode;

        const webA = await openSocket(`/ws?role=web&serverId=${serverId}&pairCode=${pairCode}`);
        expect(webA.status).toBe(101);
        const readyA = await webA.nextMessage();
        expect(readyA.type).toBe("relay.ready");
        expect(typeof readyA.data.clientId).toBe("string");
        expect(readyA.data.webClients).toBe(1);
        const peersA1 = await webA.nextMessage();
        expect(peersA1.type).toBe("web.peers");
        expect(peersA1.data.webClients).toBe(1);
        await plugin.nextMessage();

        const webB = await openSocket(`/ws?role=web&serverId=${serverId}&pairCode=${pairCode}`);
        expect(webB.status).toBe(101);
        const readyB = await webB.nextMessage();
        expect(readyB.type).toBe("relay.ready");
        expect(typeof readyB.data.clientId).toBe("string");
        expect(readyB.data.clientId).not.toBe(readyA.data.clientId);
        expect(readyB.data.webClients).toBe(2);
        const peersB2 = await webB.nextMessage();
        expect(peersB2.type).toBe("web.peers");
        expect(peersB2.data.webClients).toBe(2);
        const peersA2 = await webA.nextMessage();
        expect(peersA2.type).toBe("web.peers");
        expect(peersA2.data.webClients).toBe(2);
        await plugin.nextMessage();

        // uji sinkron bone langsung antar device web
        webA.ws.send(
            JSON.stringify({
                type: "editor.live.bones",
                requestId: "live_bone_1",
                data: {
                    playerName: "Fajeray",
                    bones: [{ name: "head", position: [0, 12, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }],
                },
            })
        );
        const boneOnB = await webB.nextMessage();
        expect(boneOnB.type).toBe("from.web");
        expect(boneOnB.sourceClientId).toBe(readyA.data.clientId);
        expect(boneOnB.message.type).toBe("editor.live.bones");
        expect(boneOnB.message.data.bones[0].name).toBe("head");

        // uji live apply tanpa skinData pas pake reuseCurrentSkinData
        webA.ws.send(
            JSON.stringify({
                type: "player.skin.apply",
                requestId: "live_apply_1",
                data: {
                    playerName: "Fajeray",
                    skinId: "steve_b3d_live_1",
                    geometryName: "geometry.humanoid.custom",
                    geometryData: "{}",
                    live: true,
                    reuseCurrentSkinData: true,
                    bones: [{ name: "head", position: [0, 12, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }],
                },
            })
        );
        const applyOnPlugin = await plugin.nextMessage();
        expect(applyOnPlugin.type).toBe("from.web");
        expect(applyOnPlugin.sourceClientId).toBe(readyA.data.clientId);
        expect(applyOnPlugin.message.type).toBe("player.skin.apply");
        expect(applyOnPlugin.message.data.reuseCurrentSkinData).toBe(true);

        const applyOnB = await webB.nextMessage();
        expect(applyOnB.type).toBe("from.web");
        expect(applyOnB.sourceClientId).toBe(readyA.data.clientId);
        expect(applyOnB.message.type).toBe("player.skin.apply");

        // uji routing player skin response cuma ke device yg minta kalo targetClientId diset
        webA.ws.send(
            JSON.stringify({
                type: "player.skin.request",
                requestId: "req_skin_1",
                data: { playerName: "Fajeray" },
            })
        );
        const skinReqPlugin = await plugin.nextMessage();
        expect(skinReqPlugin.sourceClientId).toBe(readyA.data.clientId);
        plugin.ws.send(
            JSON.stringify({
                type: "player.skin.response",
                requestId: "req_skin_1",
                data: {
                    playerName: "Fajeray",
                    skinId: "Standard_Custom",
                    skinData: "AAAA",
                    targetClientId: skinReqPlugin.sourceClientId,
                },
            })
        );
        const targetedToA = await webA.nextMessage();
        expect(targetedToA.type).toBe("from.plugin");
        expect(targetedToA.message.type).toBe("player.skin.response");
        await expect(webB.nextMessage(150)).rejects.toThrow("Timed out");

        webA.ws.close(1000, "test done");
        webB.ws.close(1000, "test done");
        plugin.ws.close(1000, "test done");
    });

    it("forwards cosmetics catalog and publish messages between web and plugin", async () => {
        const serverId = "srv_cos_test";
        const secret = "cosmetics_secret_1234567890";
        const plugin = await connectWs("/ws?role=plugin&serverId=" + serverId + "&secret=" + secret);
        await plugin.nextMessage();

        plugin.ws.send(JSON.stringify({ type: "relay.pair.create", requestId: "pair_cos", data: { ttlSeconds: 300 } }));
        const pairRes = await plugin.nextMessage();
        const pairCode = pairRes.data.pairCode;

        const web = await connectWs("/ws?role=web&serverId=" + serverId + "&pairCode=" + pairCode);
        const readyWeb = await web.nextMessage();
        await web.nextMessage();
        await plugin.nextMessage();

        // uji request katalog cosmetics dari web ke plugin
        web.ws.send(JSON.stringify({ type: "cosmetics.catalog.request", requestId: "cos_cat_1", data: {} }));
        const catReq = await plugin.nextMessage();
        expect(catReq.type).toBe("from.web");
        expect(catReq.message.type).toBe("cosmetics.catalog.request");

        plugin.ws.send(
            JSON.stringify({
                type: "cosmetics.catalog.response",
                requestId: "cos_cat_1",
                data: { categories: { Wing: { label: "SAYAP" } }, items: [{ id: "butterfly_wing", name: "Butterfly Wing" }] },
            })
        );
        const catRes = await web.nextMessage();
        expect(catRes.type).toBe("from.plugin");
        expect(catRes.message.type).toBe("cosmetics.catalog.response");
        expect(catRes.message.data.items[0].id).toBe("butterfly_wing");

        // uji publish item cosmetics dari web ke plugin trus balikin hasilnya
        web.ws.send(
            JSON.stringify({
                type: "cosmetics.item.publish",
                requestId: "cos_pub_1",
                data: { name: "Test Wing", category: "Wing", geometry: { format_version: "1.12.0" } },
            })
        );
        const pubReq = await plugin.nextMessage();
        expect(pubReq.sourceClientId).toBe(readyWeb.data.clientId);
        expect(pubReq.message.type).toBe("cosmetics.item.publish");

        plugin.ws.send(
            JSON.stringify({
                type: "cosmetics.item.publish.result",
                requestId: "cos_pub_1",
                data: { success: true, id: "test_wing" },
            })
        );
        const pubRes = await web.nextMessage();
        expect(pubRes.message.type).toBe("cosmetics.item.publish.result");
        expect(pubRes.message.data.success).toBe(true);

        web.ws.close(1000, "test done");
        plugin.ws.close(1000, "test done");
    });
});
