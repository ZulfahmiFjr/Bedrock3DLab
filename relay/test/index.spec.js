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
});
