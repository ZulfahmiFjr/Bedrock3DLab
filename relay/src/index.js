import { DurableObject } from "cloudflare:workers";

const MAX_MESSAGE_SIZE = 1024 * 1024;
const MIN_PLUGIN_SECRET_LENGTH = 16;
const DEFAULT_PAIR_TTL_SECONDS = 900;
const MIN_PAIR_TTL_SECONDS = 60;
const MAX_PAIR_TTL_SECONDS = 3600;
const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
};

const WEB_TO_PLUGIN_TYPES = new Set([
    "relay.ping",
    "server.status.request",
    "server.players.request",
    "player.skin.request",
    "player.skin.apply",
    "player.skin.revert",
    "cosmetics.catalog.request",
    "cosmetics.item.request",
    "cosmetics.item.publish",
    "cosmetics.item.delete",
    "cosmetics.sync.request",
]);

const WEB_TO_WEB_TYPES = new Set([
    "editor.live.bones",
]);

const PLUGIN_TO_WEB_TYPES = new Set([
    "relay.pong",
    "server.status.response",
    "server.players.response",
    "player.skin.response",
    "player.skin.apply.result",
    "player.skin.revert.result",
    "server.event.player_join",
    "server.event.player_quit",
    "server.event.skin_changed",
    "cosmetics.catalog.response",
    "cosmetics.item.response",
    "cosmetics.item.publish.result",
    "cosmetics.item.delete.result",
    "cosmetics.sync.result",
    "server.event.cosmetics_synced",
    "relay.error",
]);

const PLUGIN_CONTROL_TYPES = new Set([
    "relay.ping",
    "relay.pair.create",
    "relay.pair.revoke",
]);

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "content-type": "application/json",
            ...CORS_HEADERS,
        },
    });
}

function safeCompare(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

async function sha256Hex(value) {
    const encoded = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function normalizePairCode(code) {
    if (typeof code !== "string") return "";
    return code.trim().replace(/[\s-]+/g, "").toUpperCase();
}

function generatePairCode() {
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);
    let raw = "";
    for (const byte of randomBytes) {
        raw += PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length];
    }
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function isValidServerId(serverId) {
    return typeof serverId === "string" && /^[A-Za-z0-9_-]{2,64}$/.test(serverId);
}

function createRequestId() {
    return `req_${crypto.randomUUID()}`;
}

function createRelayError(code, message, requestId = null) {
    return {
        type: "relay.error",
        requestId,
        data: {
            code,
            message,
        },
    };
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}

function hasPlayerTarget(data) {
    return isNonEmptyString(data.playerUuid) || isNonEmptyString(data.playerName);
}

function parseJsonObject(rawMessage) {
    if (typeof rawMessage !== "string") {
        return {
            ok: false,
            error: createRelayError("INVALID_MESSAGE_FORMAT", "Message must be a JSON string."),
        };
    }
    if (rawMessage.length > MAX_MESSAGE_SIZE) {
        return {
            ok: false,
            error: createRelayError("MESSAGE_TOO_LARGE", "Message is too large."),
        };
    }
    let message;
    try {
        message = JSON.parse(rawMessage);
    } catch {
        return {
            ok: false,
            error: createRelayError("INVALID_JSON", "Message must be valid JSON."),
        };
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
        return {
            ok: false,
            error: createRelayError("INVALID_MESSAGE_OBJECT", "Message must be a JSON object."),
        };
    }
    if (!isNonEmptyString(message.type)) {
        return {
            ok: false,
            error: createRelayError("MISSING_TYPE", "Message type is required."),
        };
    }
    return {
        ok: true,
        message: {
            type: message.type,
            requestId: isNonEmptyString(message.requestId) ? message.requestId : createRequestId(),
            data: message.data && typeof message.data === "object" && !Array.isArray(message.data) ? message.data : {},
            createdAt: new Date().toISOString(),
        },
    };
}

function validatePlayerListResponse(message) {
    const players = message.data?.players;
    if (!Array.isArray(players)) {
        return {
            ok: false,
            error: createRelayError(
                "INVALID_PLAYERS_LIST",
                "server.players.response requires data.players as an array.",
                message.requestId
            ),
        };
    }
    for (const [index, player] of players.entries()) {
        if (!player || typeof player !== "object" || Array.isArray(player)) {
            return {
                ok: false,
                error: createRelayError(
                    "INVALID_PLAYER_OBJECT",
                    `Player at index ${index} must be an object.`,
                    message.requestId
                ),
            };
        }
        if (!isNonEmptyString(player.name)) {
            return {
                ok: false,
                error: createRelayError(
                    "MISSING_PLAYER_NAME",
                    `Player at index ${index} requires name.`,
                    message.requestId
                ),
            };
        }
        if (player.uuid !== undefined && typeof player.uuid !== "string") {
            return {
                ok: false,
                error: createRelayError(
                    "INVALID_PLAYER_UUID",
                    `Player at index ${index} uuid must be a string when provided.`,
                    message.requestId
                ),
            };
        }
        if (player.online !== undefined && typeof player.online !== "boolean") {
            return {
                ok: false,
                error: createRelayError(
                    "INVALID_PLAYER_ONLINE_STATE",
                    `Player at index ${index} online must be a boolean when provided.`,
                    message.requestId
                ),
            };
        }
    }
    return { ok: true };
}

function validateSkinResponse(message) {
    const data = message.data || {};
    if (!hasPlayerTarget(data)) {
        return {
            ok: false,
            error: createRelayError(
                "MISSING_PLAYER_TARGET",
                "player.skin.response requires playerUuid or playerName.",
                message.requestId
            ),
        };
    }
    if (!isNonEmptyString(data.skinId)) {
        return {
            ok: false,
            error: createRelayError(
                "MISSING_SKIN_ID",
                "player.skin.response requires skinId.",
                message.requestId
            ),
        };
    }
    if (!isNonEmptyString(data.skinData)) {
        return {
            ok: false,
            error: createRelayError(
                "MISSING_SKIN_DATA",
                "player.skin.response requires skinData.",
                message.requestId
            ),
        };
    }
    if (data.capeData !== undefined && typeof data.capeData !== "string") {
        return {
            ok: false,
            error: createRelayError("INVALID_CAPE_DATA", "capeData must be a string when provided.", message.requestId),
        };
    }
    if (data.geometryName !== undefined && typeof data.geometryName !== "string") {
        return {
            ok: false,
            error: createRelayError(
                "INVALID_GEOMETRY_NAME",
                "geometryName must be a string when provided.",
                message.requestId
            ),
        };
    }
    if (data.geometryData !== undefined && typeof data.geometryData !== "string") {
        return {
            ok: false,
            error: createRelayError(
                "INVALID_GEOMETRY_DATA",
                "geometryData must be a string when provided.",
                message.requestId
            ),
        };
    }
    return { ok: true };
}

function validateActionResult(message) {
    const data = message.data || {};
    if (!hasPlayerTarget(data)) {
        return {
            ok: false,
            error: createRelayError(
                "MISSING_PLAYER_TARGET",
                `${message.type} requires playerUuid or playerName.`,
                message.requestId
            ),
        };
    }
    if (typeof data.success !== "boolean") {
        return {
            ok: false,
            error: createRelayError(
                "MISSING_SUCCESS_STATE",
                `${message.type} requires success as boolean.`,
                message.requestId
            ),
        };
    }
    if (data.error !== undefined && typeof data.error !== "string") {
        return {
            ok: false,
            error: createRelayError("INVALID_ERROR_MESSAGE", "error must be a string when provided.", message.requestId),
        };
    }
    return { ok: true };
}

function validateMessageData(message) {
    const data = message.data || {};
    switch (message.type) {
        case "relay.ping":
        case "server.status.request":
        case "server.players.request":
        case "cosmetics.catalog.request":
        case "cosmetics.sync.request":
            return { ok: true };
        case "cosmetics.item.request":
        case "cosmetics.item.delete":
            if (!isNonEmptyString(data.id) && !isNonEmptyString(data.slug)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_COSMETIC_ID",
                        message.type + " requires id or slug.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "cosmetics.item.publish":
            if (!isNonEmptyString(data.name)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_COSMETIC_NAME",
                        "cosmetics.item.publish requires name.",
                        message.requestId
                    ),
                };
            }
            if (data.geometry === undefined || (typeof data.geometry !== "object" && typeof data.geometry !== "string")) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_COSMETIC_GEOMETRY",
                        "cosmetics.item.publish requires geometry object or JSON string.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "cosmetics.catalog.response":
            if (!Array.isArray(data.items)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_COSMETICS_CATALOG",
                        "cosmetics.catalog.response requires data.items as an array.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "cosmetics.item.response":
            if (!data.meta || typeof data.meta !== "object") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_COSMETIC_META",
                        "cosmetics.item.response requires meta object.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "cosmetics.item.publish.result":
        case "cosmetics.item.delete.result":
        case "cosmetics.sync.result":
            if (typeof data.success !== "boolean") {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_SUCCESS_STATE",
                        message.type + " requires success as boolean.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "server.event.cosmetics_synced":
            return { ok: true };
        case "player.skin.request":
        case "player.skin.revert":
            if (!hasPlayerTarget(data)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_PLAYER_TARGET",
                        `${message.type} requires playerUuid or playerName.`,
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "editor.live.bones":
            if (!hasPlayerTarget(data)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_PLAYER_TARGET",
                        "editor.live.bones requires playerUuid or playerName.",
                        message.requestId
                    ),
                };
            }
            if (!Array.isArray(data.bones) || data.bones.length > 256) {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_BONES_PAYLOAD",
                        "editor.live.bones requires data.bones as an array (max 256).",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "player.skin.apply":
            if (!hasPlayerTarget(data)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_PLAYER_TARGET",
                        "player.skin.apply requires playerUuid or playerName.",
                        message.requestId
                    ),
                };
            }
            if (!isNonEmptyString(data.skinId)) {
                return {
                    ok: false,
                    error: createRelayError("MISSING_SKIN_ID", "player.skin.apply requires skinId.", message.requestId),
                };
            }
            if (data.live !== undefined && typeof data.live !== "boolean") {
                return {
                    ok: false,
                    error: createRelayError("INVALID_LIVE_FLAG", "live must be a boolean when provided.", message.requestId),
                };
            }
            if (data.reuseCurrentSkinData !== undefined && typeof data.reuseCurrentSkinData !== "boolean") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_REUSE_FLAG",
                        "reuseCurrentSkinData must be a boolean when provided.",
                        message.requestId
                    ),
                };
            }
            if (data.fullSync !== undefined && typeof data.fullSync !== "boolean") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_FULL_SYNC_FLAG",
                        "fullSync must be a boolean when provided.",
                        message.requestId
                    ),
                };
            }
            if (data.bones !== undefined && !Array.isArray(data.bones)) {
                return {
                    ok: false,
                    error: createRelayError("INVALID_BONES_ARRAY", "bones must be an array when provided.", message.requestId),
                };
            }
            if (data.reuseCurrentSkinData === true) {
                if (data.skinData !== undefined && typeof data.skinData !== "string") {
                    return {
                        ok: false,
                        error: createRelayError(
                            "INVALID_SKIN_DATA",
                            "skinData must be a string when provided.",
                            message.requestId
                        ),
                    };
                }
            } else if (!isNonEmptyString(data.skinData)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_SKIN_DATA",
                        "player.skin.apply requires skinData.",
                        message.requestId
                    ),
                };
            }
            if (data.capeData !== undefined && typeof data.capeData !== "string") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_CAPE_DATA",
                        "capeData must be a string when provided.",
                        message.requestId
                    ),
                };
            }
            if (data.geometryName !== undefined && typeof data.geometryName !== "string") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_GEOMETRY_NAME",
                        "geometryName must be a string when provided.",
                        message.requestId
                    ),
                };
            }
            if (data.geometryData !== undefined && typeof data.geometryData !== "string") {
                return {
                    ok: false,
                    error: createRelayError(
                        "INVALID_GEOMETRY_DATA",
                        "geometryData must be a string when provided.",
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        case "server.status.response":
        case "relay.pong":
        case "relay.error":
            return { ok: true };
        case "server.players.response":
            return validatePlayerListResponse(message);
        case "player.skin.response":
            return validateSkinResponse(message);
        case "player.skin.apply.result":
        case "player.skin.revert.result":
            return validateActionResult(message);
        case "server.event.player_join":
        case "server.event.player_quit":
        case "server.event.skin_changed":
            if (!hasPlayerTarget(data)) {
                return {
                    ok: false,
                    error: createRelayError(
                        "MISSING_PLAYER_TARGET",
                        `${message.type} requires playerUuid or playerName.`,
                        message.requestId
                    ),
                };
            }
            return { ok: true };
        default:
            return {
                ok: false,
                error: createRelayError(
                    "UNKNOWN_VALIDATION_TYPE",
                    `No payload validator for message type '${message.type}'.`,
                    message.requestId
                ),
            };
    }
}

export class ServerRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.notifiedClosed = new WeakSet();
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return jsonResponse({ ok: false, error: "Expected WebSocket upgrade request." }, 400);
        }
        const role = url.searchParams.get("role");
        const serverId = url.searchParams.get("serverId");
        if (!isValidServerId(serverId)) {
            return jsonResponse({ ok: false, error: "Invalid or missing serverId." }, 400);
        }
        if (role !== "plugin" && role !== "web") {
            return jsonResponse({ ok: false, error: "Invalid role. Use role=plugin or role=web." }, 400);
        }
        if (role === "plugin") {
            const authResult = await this.authenticatePlugin(request, url);
            if (!authResult.ok) {
                return jsonResponse({ ok: false, error: authResult.error }, 401);
            }
            return this.acceptPluginConnection(serverId);
        }
        const webAuth = await this.authenticateWeb(url);
        if (!webAuth.ok) {
            return jsonResponse({ ok: false, error: webAuth.error }, 401);
        }
        return this.acceptWebConnection(serverId);
    }

    async authenticatePlugin(request, url) {
        const authHeader = request.headers.get("Authorization") || "";
        const bearerSecret = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
        const secret = url.searchParams.get("secret") || bearerSecret;
        if (!secret) {
            return { ok: false, error: "Missing plugin secret." };
        }
        // dukung override secret dari env lokal pas dev
        if (this.env.PLUGIN_SECRET && safeCompare(secret, this.env.PLUGIN_SECRET)) {
            return { ok: true };
        }
        if (secret.length < MIN_PLUGIN_SECRET_LENGTH) {
            return { ok: false, error: "Plugin secret must be at least 16 characters." };
        }
        const secretHash = await sha256Hex(secret);
        const storedHash = await this.ctx.storage.get("secretHash");
        if (!storedHash) {
            // klaim room otomatis buat serverId yg baru pertama konek
            await this.ctx.storage.put("secretHash", secretHash);
            return { ok: true };
        }
        if (!safeCompare(secretHash, storedHash)) {
            return { ok: false, error: "Invalid plugin secret." };
        }
        return { ok: true };
    }

    async authenticateWeb(url) {
        const rawCode = url.searchParams.get("pairCode") ?? url.searchParams.get("code") ?? "";
        const normalizedCode = normalizePairCode(rawCode);
        if (!normalizedCode) {
            return { ok: false, error: "Missing pair code." };
        }
        if (this.env.PAIR_CODE && safeCompare(normalizedCode, normalizePairCode(this.env.PAIR_CODE))) {
            return { ok: true };
        }
        const pairSession = await this.ctx.storage.get("pairSession");
        if (!pairSession || typeof pairSession.code !== "string") {
            return { ok: false, error: "Invalid or expired pair code." };
        }
        if (Date.now() >= pairSession.expiresAt) {
            return { ok: false, error: "Pair code has expired." };
        }
        if (!safeCompare(normalizedCode, normalizePairCode(pairSession.code))) {
            return { ok: false, error: "Invalid or expired pair code." };
        }
        return { ok: true };
    }

    acceptPluginConnection(serverId) {
        for (const existing of this.ctx.getWebSockets("plugin")) {
            this.notifiedClosed.add(existing);
            try {
                existing.close(4000, "Plugin connection replaced.");
            } catch {}
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server, ["plugin"]);
        server.serializeAttachment({
            role: "plugin",
            serverId,
            connectedAt: new Date().toISOString(),
        });
        const webClients = this.ctx.getWebSockets("web").length;
        this.safeSend(server, {
            type: "relay.ready",
            role: "plugin",
            serverId,
            protocolVersion: 2,
            data: {
                message: "Plugin connected to Bedrock3DLab room.",
                webClients,
                supportedIncomingTypes: [...WEB_TO_PLUGIN_TYPES],
                supportedOutgoingTypes: [...PLUGIN_TO_WEB_TYPES],
                supportedControlTypes: [...PLUGIN_CONTROL_TYPES],
            },
        });
        this.broadcastToWeb({
            type: "plugin.connected",
            serverId,
            data: {
                message: "Plugin is now online.",
            },
        });
        return new Response(null, { status: 101, webSocket: client });
    }

    acceptWebConnection(serverId) {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const clientId = `web_${crypto.randomUUID().slice(0, 8)}`;
        this.ctx.acceptWebSocket(server, ["web"]);
        server.serializeAttachment({
            role: "web",
            serverId,
            clientId,
            connectedAt: new Date().toISOString(),
        });
        const pluginSockets = this.ctx.getWebSockets("plugin");
        const webClients = this.ctx.getWebSockets("web").length;
        this.safeSend(server, {
            type: "relay.ready",
            role: "web",
            serverId,
            protocolVersion: 2,
            data: {
                clientId,
                webClients,
                pluginOnline: pluginSockets.length > 0,
                message: "Web connected to Bedrock3DLab room.",
                supportedOutgoingTypes: [...WEB_TO_PLUGIN_TYPES],
                supportedIncomingTypes: [...PLUGIN_TO_WEB_TYPES],
                supportedWebToWebTypes: [...WEB_TO_WEB_TYPES],
            },
        });
        this.broadcastToWeb({
            type: "web.peers",
            serverId,
            data: {
                webClients,
            },
        });
        this.broadcastToPlugin({
            type: "web.connected",
            serverId,
            data: {
                message: "A web client connected.",
                webClients,
            },
        });
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, rawMessage) {
        const meta = ws.deserializeAttachment() || {};
        const parsed = parseJsonObject(rawMessage);
        if (!parsed.ok) {
            this.safeSend(ws, parsed.error);
            return;
        }
        const message = parsed.message;
        if (meta.role === "plugin") {
            if (PLUGIN_CONTROL_TYPES.has(message.type)) {
                await this.handlePluginControlMessage(ws, meta.serverId, message);
                return;
            }
            if (!PLUGIN_TO_WEB_TYPES.has(message.type)) {
                this.safeSend(
                    ws,
                    createRelayError(
                        "UNSUPPORTED_MESSAGE_TYPE",
                        `Message type '${message.type}' is not allowed for role 'plugin'.`,
                        message.requestId
                    )
                );
                return;
            }
            const validation = validateMessageData(message);
            if (!validation.ok) {
                this.safeSend(ws, validation.error);
                return;
            }
            const pluginEnvelope = {
                type: "from.plugin",
                serverId: meta.serverId,
                message,
            };
            if (
                (message.type === "player.skin.response" || message.type === "cosmetics.item.response") &&
                isNonEmptyString(message.data?.targetClientId)
            ) {
                this.sendToWebClient(message.data.targetClientId, pluginEnvelope);
                return;
            }
            this.broadcastToWeb(pluginEnvelope);
            return;
        }
        if (meta.role === "web") {
            if (WEB_TO_WEB_TYPES.has(message.type)) {
                const validation = validateMessageData(message);
                if (!validation.ok) {
                    this.safeSend(ws, validation.error);
                    return;
                }
                this.broadcastToOtherWeb(ws, {
                    type: "from.web",
                    serverId: meta.serverId,
                    sourceClientId: meta.clientId || null,
                    message,
                });
                return;
            }
            if (!WEB_TO_PLUGIN_TYPES.has(message.type)) {
                this.safeSend(
                    ws,
                    createRelayError(
                        "UNSUPPORTED_MESSAGE_TYPE",
                        `Message type '${message.type}' is not allowed for role 'web'.`,
                        message.requestId
                    )
                );
                return;
            }
            const validation = validateMessageData(message);
            if (!validation.ok) {
                this.safeSend(ws, validation.error);
                return;
            }
            const pluginSockets = this.ctx.getWebSockets("plugin");
            if (pluginSockets.length === 0) {
                this.safeSend(
                    ws,
                    createRelayError("PLUGIN_OFFLINE", "No plugin connected for this serverId.", message.requestId)
                );
                return;
            }
            const webEnvelope = {
                type: "from.web",
                serverId: meta.serverId,
                sourceClientId: meta.clientId || null,
                message,
            };
            this.broadcastToPlugin(webEnvelope);
            // broadcast apply skin ke browser lain biar smua device langsung sync bareng
            if (message.type === "player.skin.apply") {
                this.broadcastToOtherWeb(ws, webEnvelope);
            }
        }
    }

    async handlePluginControlMessage(ws, serverId, message) {
        if (message.type === "relay.ping") {
            this.safeSend(ws, {
                type: "relay.pong",
                requestId: message.requestId,
                data: {
                    serverTime: new Date().toISOString(),
                },
            });
            return;
        }
        if (message.type === "relay.pair.create") {
            const rawTtl = Number(message.data?.ttlSeconds);
            const ttlSeconds = Number.isFinite(rawTtl)
                ? Math.min(MAX_PAIR_TTL_SECONDS, Math.max(MIN_PAIR_TTL_SECONDS, Math.round(rawTtl)))
                : DEFAULT_PAIR_TTL_SECONDS;
            const code = generatePairCode();
            const createdAt = Date.now();
            const expiresAt = createdAt + ttlSeconds * 1000;
            await this.ctx.storage.put("pairSession", { code, expiresAt, createdAt });
            this.safeSend(ws, {
                type: "relay.pair.created",
                requestId: message.requestId,
                data: {
                    serverId,
                    pairCode: code,
                    expiresAt: new Date(expiresAt).toISOString(),
                    ttlSeconds,
                },
            });
            return;
        }
        if (message.type === "relay.pair.revoke") {
            await this.ctx.storage.delete("pairSession");
            const webSockets = this.ctx.getWebSockets("web");
            let disconnectedWebClients = 0;
            for (const clientWs of webSockets) {
                this.notifiedClosed.add(clientWs);
                try {
                    clientWs.close(4001, "Pairing session revoked by server.");
                    disconnectedWebClients += 1;
                } catch {}
            }
            this.safeSend(ws, {
                type: "relay.pair.revoked",
                requestId: message.requestId,
                data: {
                    serverId,
                    disconnectedWebClients,
                },
            });
        }
    }

    async webSocketClose(ws, code, reason) {
        try {
            ws.close(code || 1000, reason || "Closed");
        } catch {}
        this.handleDisconnect(ws);
    }

    async webSocketError(ws) {
        try {
            ws.close(1011, "WebSocket error.");
        } catch {}
        this.handleDisconnect(ws);
    }

    handleDisconnect(ws) {
        if (this.notifiedClosed.has(ws)) return;
        this.notifiedClosed.add(ws);
        const meta = ws.deserializeAttachment() || {};
        if (meta.role === "plugin") {
            const remaining = this.ctx.getWebSockets("plugin").filter((socket) => socket !== ws);
            if (remaining.length === 0) {
                this.broadcastToWeb({
                    type: "plugin.disconnected",
                    serverId: meta.serverId,
                    data: {
                        message: "Plugin disconnected.",
                    },
                });
            }
            return;
        }
        if (meta.role === "web") {
            const remainingWeb = this.ctx.getWebSockets("web").filter((socket) => socket !== ws).length;
            this.broadcastToOtherWeb(ws, {
                type: "web.peers",
                serverId: meta.serverId,
                data: {
                    webClients: remainingWeb,
                },
            });
            this.broadcastToPlugin({
                type: "web.disconnected",
                serverId: meta.serverId,
                data: {
                    webClients: remainingWeb,
                },
            });
        }
    }

    broadcastToWeb(message) {
        for (const socket of this.ctx.getWebSockets("web")) {
            this.safeSend(socket, message);
        }
    }

    broadcastToOtherWeb(excludeWs, message) {
        for (const socket of this.ctx.getWebSockets("web")) {
            if (socket !== excludeWs) {
                this.safeSend(socket, message);
            }
        }
    }

    sendToWebClient(clientId, message) {
        if (!clientId) return false;
        let sent = false;
        for (const socket of this.ctx.getWebSockets("web")) {
            const meta = socket.deserializeAttachment() || {};
            if (meta.clientId === clientId) {
                this.safeSend(socket, message);
                sent = true;
            }
        }
        return sent;
    }

    broadcastToPlugin(message) {
        for (const socket of this.ctx.getWebSockets("plugin")) {
            this.safeSend(socket, message);
        }
    }

    safeSend(socket, message) {
        try {
            socket.send(JSON.stringify(message));
        } catch {}
    }
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        const url = new URL(request.url);
        if (url.pathname === "/" || url.pathname === "/health") {
            return jsonResponse({
                ok: true,
                name: "Bedrock3DLab Relay",
                status: "running",
                protocolVersion: 2,
                endpoints: {
                    plugin: "/ws?role=plugin&serverId=<serverId>&secret=<serverSecret>",
                    web: "/ws?role=web&serverId=<serverId>&pairCode=<pairCode>",
                },
                messageTypes: {
                    webToPlugin: [...WEB_TO_PLUGIN_TYPES],
                    webToWeb: [...WEB_TO_WEB_TYPES],
                    pluginToWeb: [...PLUGIN_TO_WEB_TYPES],
                    pluginControl: [...PLUGIN_CONTROL_TYPES],
                },
            });
        }
        if (url.pathname === "/ws") {
            const serverId = url.searchParams.get("serverId");
            if (!isValidServerId(serverId)) {
                return jsonResponse({ ok: false, error: "Invalid or missing serverId." }, 400);
            }
            const roomId = env.SERVER_ROOM.idFromName(serverId);
            const room = env.SERVER_ROOM.get(roomId);
            return room.fetch(request);
        }
        return jsonResponse({ ok: false, error: "Not found." }, 404);
    },
};
