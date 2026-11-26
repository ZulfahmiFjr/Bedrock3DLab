// modul Cosmetics Studio buat integrasi 2 arah antara Bedrock3DLab sama server Cosmetics Altay

const DEFAULT_STUDIO_URL = "https://43.156.152.8:8443/cosmetics-studio";
const PATCH_X_BY_CATEGORY = { Wing: 56, Cap: 32, Tail: 0, Tool: 24 };
const PLAYER_BASE_BONES = new Set([
    "root",
    "waist",
    "body",
    "head",
    "hat",
    "jacket",
    "rightArm",
    "rightSleeve",
    "leftArm",
    "leftSleeve",
    "rightLeg",
    "rightPants",
    "leftLeg",
    "leftPants",
    "rightItem",
    "leftItem",
    "cape",
]);

function slugify(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function rgbToHex(rgb) {
    const [r, g, b] = (Array.isArray(rgb) ? rgb : [255, 255, 255]).map((v) =>
        Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
    );
    return (
        "#" +
        [r, g, b]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("")
    );
}

function hexToRgb(hex) {
    const clean = String(hex || "#ffffff").replace("#", "").trim();
    if (clean.length !== 6) return [255, 255, 255];
    return [
        parseInt(clean.slice(0, 2), 16) || 0,
        parseInt(clean.slice(2, 4), 16) || 0,
        parseInt(clean.slice(4, 6), 16) || 0,
    ];
}

function cloneJson(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function shiftBoneUv(bone, ox, oy) {
    if (!ox && !oy) return bone;
    const out = cloneJson(bone);
    if (!Array.isArray(out.cubes)) return out;
    out.cubes.forEach((cube) => {
        const uv = cube.uv;
        if (Array.isArray(uv) && uv.length === 2) {
            cube.uv = [Number(uv[0]) + ox, Number(uv[1]) + oy];
        } else if (uv && typeof uv === "object") {
            Object.values(uv).forEach((face) => {
                if (face && Array.isArray(face.uv) && face.uv.length === 2) {
                    face.uv = [Number(face.uv[0]) + ox, Number(face.uv[1]) + oy];
                }
            });
        }
    });
    return out;
}

export function convertBbmodelToBedrockGeometry(bb) {
    // ubah file Blockbench bbmodel ke format Bedrock 1_12_0 per-face atau box UV
    const texW = Number(bb?.resolution?.width || 64);
    const texH = Number(bb?.resolution?.height || 64);
    const elems = new Map((bb?.elements || []).map((el) => [el.uuid, el]));
    const bones = [];
    const walkOutliner = (nodes, parentName = null) => {
        for (const node of nodes || []) {
            if (typeof node === "string") continue;
            const bname = String(node.name || "bone");
            const bone = {
                name: bname,
                pivot: Array.isArray(node.origin) ? node.origin.map(Number) : [0, 0, 0],
            };
            if (parentName) bone.parent = parentName;
            if (Array.isArray(node.rotation) && node.rotation.some((v) => Math.abs(Number(v)) > 1e-5)) {
                bone.rotation = node.rotation.map(Number);
            }
            const cubes = [];
            for (const ch of node.children || []) {
                if (typeof ch !== "string" || !elems.has(ch)) continue;
                const el = elems.get(ch);
                if (!Array.isArray(el.from) || !Array.isArray(el.to)) continue;
                const size = [
                    Number((el.to[0] - el.from[0]).toFixed(4)),
                    Number((el.to[1] - el.from[1]).toFixed(4)),
                    Number((el.to[2] - el.from[2]).toFixed(4)),
                ];
                const cube = { origin: el.from.map(Number), size };
                if (typeof el.inflate === "number" && el.inflate !== 0) cube.inflate = el.inflate;
                if (Array.isArray(el.rotation) && el.rotation.some((v) => Math.abs(Number(v)) > 1e-5)) {
                    cube.pivot = Array.isArray(el.origin) ? el.origin.map(Number) : [0, 0, 0];
                    cube.rotation = el.rotation.map(Number);
                }
                if (el.faces && !el.box_uv) {
                    const uvObj = {};
                    for (const face of ["north", "south", "east", "west", "up", "down"]) {
                        if (el.faces[face] && Array.isArray(el.faces[face].uv)) {
                            const [u0, v0, u1, v1] = el.faces[face].uv.map(Number);
                            uvObj[face] = { uv: [u0, v0], uv_size: [u1 - u0, v1 - v0] };
                        }
                    }
                    cube.uv = uvObj;
                } else {
                    cube.uv = Array.isArray(el.uv_offset) ? el.uv_offset.map(Number) : [0, 0];
                }
                cubes.push(cube);
            }
            if (cubes.length > 0) bone.cubes = cubes;
            bones.push(bone);
            walkOutliner(node.children || [], bname);
        }
    };
    walkOutliner(bb?.outliner || [], null);
    let embeddedTexture = null;
    if (Array.isArray(bb?.textures) && bb.textures[0] && typeof bb.textures[0].source === "string") {
        embeddedTexture = bb.textures[0].source;
    }
    return {
        geometry: {
            format_version: "1.12.0",
            "minecraft:geometry": [
                {
                    description: {
                        identifier: "geometry.cosmetics." + slugify(bb?.model_identifier || bb?.name || "custom"),
                        texture_width: texW,
                        texture_height: texH,
                        visible_bounds_width: 8,
                        visible_bounds_height: 8,
                        visible_bounds_offset: [0, 1.5, 0],
                    },
                    bones,
                },
            ],
        },
        embeddedTexture,
    };
}

function extractBonesFromGeometry(rawGeo) {
    if (!rawGeo || typeof rawGeo !== "object") return { bones: [], texW: 64, texH: 64 };
    if (Array.isArray(rawGeo["minecraft:geometry"]) && rawGeo["minecraft:geometry"][0]) {
        const g0 = rawGeo["minecraft:geometry"][0];
        return {
            bones: Array.isArray(g0.bones) ? cloneJson(g0.bones) : [],
            texW: Number(g0.description?.texture_width || 64),
            texH: Number(g0.description?.texture_height || 64),
        };
    }
    if (Array.isArray(rawGeo)) {
        return { bones: cloneJson(rawGeo), texW: 64, texH: 64 };
    }
    for (const [key, val] of Object.entries(rawGeo)) {
        if (key.startsWith("geometry.") && val && Array.isArray(val.bones)) {
            return {
                bones: cloneJson(val.bones),
                texW: Number(val.texturewidth || 64),
                texH: Number(val.textureheight || 64),
            };
        }
    }
    return { bones: [], texW: 64, texH: 64 };
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("gagal memuat gambar tekstur"));
        img.src = src;
    });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("gagal membaca file teks"));
        reader.readAsText(file);
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("gagal membaca file PNG"));
        reader.readAsDataURL(file);
    });
}

export function initCosmeticsStudio(bridge) {
    const panel = document.getElementById("cosmeticsStudioPanel");
    if (!panel) return null;

    const urlInput = document.getElementById("studioUrlInput");
    const tokenInput = document.getElementById("studioTokenInput");
    const connectBtn = document.getElementById("studioConnectBtn");
    const syncBtn = document.getElementById("studioSyncBtn");
    const statusText = document.getElementById("studioStatusText");
    const catalogSection = document.getElementById("studioCatalogSection");
    const itemsCount = document.getElementById("studioItemsCount");
    const refreshBtn = document.getElementById("studioRefreshBtn");
    const newBtn = document.getElementById("studioNewBtn");
    const categoryTabs = document.getElementById("studioCategoryTabs");
    const itemsList = document.getElementById("studioItemsList");
    const modeBadge = document.getElementById("studioModeBadge");
    const modelFileInput = document.getElementById("studioModelFile");
    const modelFileLabel = document.getElementById("studioModelFileLabel");
    const textureFileInput = document.getElementById("studioTextureFile");
    const textureFileLabel = document.getElementById("studioTextureFileLabel");
    const nameInput = document.getElementById("studioNameInput");
    const categorySelect = document.getElementById("studioCategorySelect");
    const attachSelect = document.getElementById("studioAttachSelect");
    const colorLayersEl = document.getElementById("studioColorLayers");
    const addColorBtn = document.getElementById("studioAddColorBtn");
    const removeColorBtn = document.getElementById("studioRemoveColorBtn");
    const publishBtn = document.getElementById("studioPublishBtn");
    const deleteBtn = document.getElementById("studioDeleteBtn");
    const jobStatusEl = document.getElementById("studioJobStatus");

    let connected = false;
    let catalogItems = [];
    let activeCategoryFilter = "ALL";
    let playerGeoCache = null;
    let playerImgCache = null;
    let pollTimer = null;

    // state kosmetik yg lagi diedit di viewport 3D
    let activeCosmetic = {
        slug: "",
        isExisting: false,
        name: "",
        category: "Wing",
        attachmentBone: "jacket",
        colorLayers: [
            [0, 170, 255],
            [255, 255, 255],
        ],
        textured: false,
        partMapDataUrl: null,
        textureDataUrl: null,
        rawGeo: null,
        cosmeticBoneNames: new Set(),
        reverseRenameMap: new Map(),
        uvShift: [0, 0],
        texW: 64,
        texH: 64,
    };

    function getBaseUrl() {
        const raw = (urlInput?.value || "").trim().replace(/\/+$/, "");
        if (raw) return raw;
        if (window.location.pathname.startsWith("/cosmetics-studio")) {
            return window.location.origin + "/cosmetics-studio";
        }
        return DEFAULT_STUDIO_URL;
    }

    function getToken() {
        return (tokenInput?.value || "").trim();
    }

    function setStatus(message) {
        if (statusText) statusText.textContent = "Studio: " + message;
    }

    function setJobStatus(message, visible = true) {
        if (!jobStatusEl) return;
        jobStatusEl.textContent = message || "";
        jobStatusEl.classList.toggle("is-hidden", !visible || !message);
    }

    function updateButtons() {
        if (syncBtn) syncBtn.disabled = !connected;
        const hasGeo = Boolean(activeCosmetic.rawGeo);
        if (publishBtn) publishBtn.disabled = !connected || !hasGeo;
        if (deleteBtn) deleteBtn.disabled = !connected || !activeCosmetic.isExisting || !activeCosmetic.slug;
        if (modeBadge) {
            modeBadge.textContent = activeCosmetic.isExisting
                ? "Edit: " + activeCosmetic.slug
                : hasGeo
                ? "New Cosmetic"
                : "Local / New";
        }
    }

    async function apiRequest(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        const token = getToken();
        if (token) {
            headers["Authorization"] = "Bearer " + token;
            headers["X-Studio-Token"] = token;
        }
        if (options.body && !headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
        }
        const res = await fetch(getBaseUrl() + path, { ...options, headers });
        const data = await res.json().catch(() => ({ ok: false, error: "Invalid JSON response" }));
        if (!res.ok || data.ok === false) {
            throw new Error(data.error || "HTTP " + res.status);
        }
        return data;
    }

    async function ensurePlayerBaseAssets() {
        if (!playerGeoCache) {
            const res = await fetch("./assets/player.json");
            if (!res.ok) throw new Error("gagal memuat assets/player.json");
            playerGeoCache = await res.json();
        }
        if (!playerImgCache) {
            playerImgCache = await loadImageElement("./assets/player.png");
        }
        return { geo: playerGeoCache, img: playerImgCache };
    }

    function renderColorLayerInputs() {
        if (!colorLayersEl) return;
        colorLayersEl.innerHTML = "";
        activeCosmetic.colorLayers.forEach((rgb, idx) => {
            const chip = document.createElement("label");
            chip.className = "studio-color-chip";
            const input = document.createElement("input");
            input.type = "color";
            input.value = rgbToHex(rgb);
            input.addEventListener("input", () => {
                activeCosmetic.colorLayers[idx] = hexToRgb(input.value);
                if (activeCosmetic.rawGeo) {
                    refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
                }
            });
            const lbl = document.createElement("span");
            lbl.textContent = "W" + (idx + 1);
            chip.appendChild(input);
            chip.appendChild(lbl);
            colorLayersEl.appendChild(chip);
        });
    }

    async function buildPreviewTextureUrl() {
        const { img: playerImg } = await ensurePlayerBaseAssets();
        const useTextured128 = Boolean(activeCosmetic.partMapDataUrl || activeCosmetic.textureDataUrl);
        const canvas = document.createElement("canvas");
        canvas.width = useTextured128 ? 128 : 64;
        canvas.height = useTextured128 ? 128 : 64;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(playerImg, 0, 0, 64, 64);

        if (activeCosmetic.partMapDataUrl) {
            const pmImg = await loadImageElement(activeCosmetic.partMapDataUrl);
            const tmp = document.createElement("canvas");
            tmp.width = 64;
            tmp.height = 64;
            const tctx = tmp.getContext("2d");
            tctx.drawImage(pmImg, 0, 0, 64, 64);
            const imgData = tctx.getImageData(0, 0, 64, 64);
            const px = imgData.data;
            for (let i = 0; i < px.length; i += 4) {
                if (px[i + 3] < 20 || px[i] === 0) {
                    px[i + 3] = 0;
                    continue;
                }
                const partIdx = px[i] - 1;
                const shade = px[i + 1] / 255;
                const hl = px[i + 2] / 255;
                const rgb = activeCosmetic.colorLayers[partIdx] || [255, 255, 255];
                px[i] = Math.min(255, Math.round(rgb[0] * shade * (1 - hl) + 255 * hl));
                px[i + 1] = Math.min(255, Math.round(rgb[1] * shade * (1 - hl) + 255 * hl));
                px[i + 2] = Math.min(255, Math.round(rgb[2] * shade * (1 - hl) + 255 * hl));
                px[i + 3] = 255;
            }
            tctx.putImageData(imgData, 0, 0);
            ctx.drawImage(tmp, 64, 0, 64, 64);
        } else if (activeCosmetic.textureDataUrl) {
            const txImg = await loadImageElement(activeCosmetic.textureDataUrl);
            ctx.drawImage(txImg, 64, 0, 64, 64);
        } else {
            // cat swatch 4x2 piksel di koordinat patch_x kategori biar kosmetik solid langsung berwarna
            const patchX = PATCH_X_BY_CATEGORY[activeCosmetic.category] ?? 56;
            activeCosmetic.colorLayers.forEach((rgb, partIdx) => {
                const pxX = patchX + Math.floor(partIdx / 4) * 4;
                const pxY = (partIdx % 4) * 2;
                ctx.fillStyle = rgbToHex(rgb);
                ctx.fillRect(pxX, pxY, 4, 2);
            });
        }
        return { texUrl: canvas.toDataURL("image/png"), useTextured128 };
    }

    async function refreshCosmeticPreview(options = {}) {
        if (!activeCosmetic.rawGeo) return;
        const { geo: playerGeo } = await ensurePlayerBaseAssets();
        const { texUrl, useTextured128 } = await buildPreviewTextureUrl();
        const { bones: cosBones, texW, texH } = extractBonesFromGeometry(activeCosmetic.rawGeo);
        activeCosmetic.texW = texW;
        activeCosmetic.texH = texH;
        const uvShift = useTextured128 ? [64, 0] : [0, 0];
        activeCosmetic.uvShift = uvShift;

        const baseDoc = cloneJson(playerGeo);
        const baseGeo = baseDoc["minecraft:geometry"][0];
        baseGeo.description.identifier = "geometry.cosmetics_preview." + (activeCosmetic.slug || "draft");
        baseGeo.description.texture_width = useTextured128 ? 128 : 64;
        baseGeo.description.texture_height = useTextured128 ? 128 : 64;

        const attach = activeCosmetic.attachmentBone || "jacket";
        const baseNames = new Set((baseGeo.bones || []).map((b) => b.name));
        const playerAttach = baseNames.has(attach) ? attach : "body";
        const cosNames = new Set();
        const renameMap = new Map();
        const reverseRenameMap = new Map();
        const keptRaw = [];
        for (const rawBone of cosBones) {
            if (!rawBone || !rawBone.name) continue;
            // lewati bone jangkar kosong yg namanya sama dgan bone player (misal body atau head)
            if (rawBone.name.toLowerCase() === attach.toLowerCase() && (!rawBone.cubes || rawBone.cubes.length === 0)) {
                continue;
            }
            keptRaw.push(rawBone);
            if (baseNames.has(rawBone.name)) {
                const mapped = "cos_" + rawBone.name;
                renameMap.set(rawBone.name, mapped);
                reverseRenameMap.set(mapped, rawBone.name);
            }
        }
        const keptNames = new Set(keptRaw.map((b) => renameMap.get(b.name) || b.name));
        for (const rawBone of keptRaw) {
            const bone = shiftBoneUv(rawBone, uvShift[0], uvShift[1]);
            const mappedName = renameMap.get(bone.name) || bone.name;
            bone.name = mappedName;
            const origParent = bone.parent || "";
            const mappedParent = renameMap.get(origParent) || origParent;
            if (!origParent || origParent.toLowerCase() === attach.toLowerCase()) {
                bone.parent = keptNames.has(mappedParent) && mappedParent !== mappedName ? mappedParent : playerAttach;
            } else if (keptNames.has(mappedParent)) {
                bone.parent = mappedParent;
            } else {
                bone.parent = playerAttach;
            }
            cosNames.add(bone.name);
            baseGeo.bones.push(bone);
        }
        activeCosmetic.cosmeticBoneNames = cosNames;
        activeCosmetic.reverseRenameMap = reverseRenameMap;

        bridge.setLoadedModelState(baseDoc, (activeCosmetic.slug || "cosmetic") + ".geo.json");
        await bridge.loadAndRender(baseGeo, texUrl, 0, {
            preserveCamera: Boolean(options.preserveCamera),
            preservePanels: options.preservePanels !== false,
            preserveSelection: Boolean(options.preserveSelection),
        });
        updateButtons();
    }

    function renderCatalogList() {
        if (!itemsList) return;
        const filtered =
            activeCategoryFilter === "ALL"
                ? catalogItems
                : catalogItems.filter((it) => it.category === activeCategoryFilter);
        if (itemsCount) itemsCount.textContent = String(filtered.length);
        itemsList.innerHTML = "";
        if (filtered.length === 0) {
            const empty = document.createElement("div");
            empty.className = "relay-player-row is-offline";
            empty.textContent = "Belum ada kosmetik di kategori ini";
            itemsList.appendChild(empty);
            return;
        }
        filtered.forEach((item) => {
            const row = document.createElement("div");
            row.className = "relay-player-row is-clickable";
            if (activeCosmetic.slug && activeCosmetic.slug === item.id) {
                row.classList.add("is-active");
            }
            const left = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = item.name || item.id;
            const meta = document.createElement("div");
            meta.className = "studio-item-meta";
            const partsCount = Array.isArray(item.color_layers) ? item.color_layers.length : 2;
            const cubes = item.optimized_cubes ?? item.legacy_cubes ?? "?";
            meta.textContent = item.category + " | " + partsCount + " warna | " + cubes + " cubes";
            left.appendChild(title);
            left.appendChild(meta);
            row.appendChild(left);
            row.addEventListener("click", () => {
                loadCatalogItem(item.id);
            });
            itemsList.appendChild(row);
        });
    }

    async function fetchCatalog() {
        setStatus("loading catalog...");
        try {
            const data = await apiRequest("/api/catalog");
            connected = true;
            catalogItems = Array.isArray(data.items) ? data.items : [];
            if (catalogSection) catalogSection.classList.remove("is-hidden");
            renderCatalogList();
            updateButtons();
            setStatus("connected (" + catalogItems.length + " cosmetics, v" + (data.version || "?") + ")");
            if (data.active_job && data.active_job.id) {
                startJobPolling(data.active_job.id);
            }
        } catch (err) {
            connected = false;
            updateButtons();
            setStatus("error: " + err.message);
        }
    }

    function setAttachSelectValue(boneName) {
        if (!attachSelect) return;
        const val = String(boneName || "jacket").trim() || "jacket";
        const exists = Array.from(attachSelect.options).some((opt) => opt.value === val);
        if (!exists) {
            const opt = document.createElement("option");
            opt.value = val;
            opt.textContent = val + " (custom)";
            attachSelect.appendChild(opt);
        }
        attachSelect.value = val;
    }

    async function loadCatalogItem(slug) {
        setStatus("loading " + slug + "...");
        try {
            const data = await apiRequest("/api/item/" + encodeURIComponent(slug));
            const meta = data.meta || {};
            activeCosmetic = {
                slug: meta.id || slug,
                isExisting: true,
                name: meta.name || slug,
                category: meta.category || "Wing",
                attachmentBone: meta.attachment_bone || "body",
                colorLayers:
                    Array.isArray(meta.color_layers) && meta.color_layers.length > 0
                        ? cloneJson(meta.color_layers)
                        : [
                              [0, 170, 255],
                              [255, 255, 255],
                          ],
                textured: Boolean(meta.textured || data.part_map_png),
                partMapDataUrl: data.part_map_png || null,
                textureDataUrl: data.texture_png || null,
                rawGeo: data.geometry,
                cosmeticBoneNames: new Set(),
                reverseRenameMap: new Map(),
                uvShift: [0, 0],
                texW: 64,
                texH: 64,
            };
            if (nameInput) nameInput.value = activeCosmetic.name;
            if (categorySelect) categorySelect.value = activeCosmetic.category;
            setAttachSelectValue(activeCosmetic.attachmentBone);
            if (modelFileLabel) modelFileLabel.textContent = activeCosmetic.slug + ".geo.json (server)";
            if (textureFileLabel) {
                textureFileLabel.textContent = activeCosmetic.partMapDataUrl
                    ? "part_map.png (server)"
                    : activeCosmetic.textureDataUrl
                    ? "texture.png (server)"
                    : "Optional part_map / texture .png...";
            }
            renderColorLayerInputs();
            renderCatalogList();
            await refreshCosmeticPreview({ preserveCamera: false, preservePanels: true });
            setStatus("loaded " + activeCosmetic.name + " (edit bone atau warna trus klik Publish)");
        } catch (err) {
            setStatus("load error: " + err.message);
        }
    }

    function resetForNewCosmetic() {
        activeCosmetic = {
            slug: "",
            isExisting: false,
            name: "",
            category: categorySelect?.value || "Wing",
            attachmentBone: attachSelect?.value || "body",
            colorLayers: [
                [0, 170, 255],
                [255, 255, 255],
            ],
            textured: false,
            partMapDataUrl: null,
            textureDataUrl: null,
            rawGeo: null,
            cosmeticBoneNames: new Set(),
            reverseRenameMap: new Map(),
            uvShift: [0, 0],
            texW: 64,
            texH: 64,
        };
        if (nameInput) nameInput.value = "";
        if (modelFileInput) modelFileInput.value = "";
        if (textureFileInput) textureFileInput.value = "";
        if (modelFileLabel) modelFileLabel.textContent = "Import .bbmodel / .json...";
        if (textureFileLabel) textureFileLabel.textContent = "Optional part_map / texture .png...";
        renderColorLayerInputs();
        renderCatalogList();
        updateButtons();
        setStatus("mode kosmetik baru, pilih file bbmodel atau json");
    }

    function collectEditedCosmeticGeometry() {
        // ambil transform bone terbaru dari ThreeJS trus saring khusus bone kosmetik saja tanpa bone player dasar
        const attach = activeCosmetic.attachmentBone || "jacket";
        const [sx, sy] = activeCosmetic.uvShift || [0, 0];
        const rev = activeCosmetic.reverseRenameMap || new Map();
        const built = bridge.buildEditedGeometryData();
        let editedBones = null;
        if (!built.error && built.exportedData?.["minecraft:geometry"]?.[0]?.bones) {
            const allBones = built.exportedData["minecraft:geometry"][0].bones;
            const filtered = allBones
                .filter((b) => activeCosmetic.cosmeticBoneNames.has(b.name))
                .map((b) => {
                    const out = shiftBoneUv(b, -sx, -sy);
                    if (rev.has(out.name)) out.name = rev.get(out.name);
                    if (out.parent && rev.has(out.parent)) out.parent = rev.get(out.parent);
                    return out;
                });
            if (filtered.length > 0) {
                editedBones = filtered;
            }
        }
        if (!editedBones) {
            editedBones = extractBonesFromGeometry(activeCosmetic.rawGeo).bones;
        }
        const hasAnchor = editedBones.some((b) => b.name.toLowerCase() === attach.toLowerCase());
        const finalBones = hasAnchor
            ? editedBones
            : [{ name: attach, pivot: [0, 0, 0] }, ...editedBones];
        const validNames = new Set(finalBones.map((b) => b.name));
        finalBones.forEach((b) => {
            if (b.name.toLowerCase() === attach.toLowerCase()) {
                b.name = attach;
                return;
            }
            if (!b.parent || !validNames.has(b.parent)) {
                b.parent = attach;
            }
        });
        return {
            format_version: "1.12.0",
            "minecraft:geometry": [
                {
                    description: {
                        identifier: "geometry.cosmetics." + slugify(activeCosmetic.name || activeCosmetic.slug || "custom"),
                        texture_width: activeCosmetic.texW || 64,
                        texture_height: activeCosmetic.texH || 64,
                        visible_bounds_width: 8,
                        visible_bounds_height: 8,
                        visible_bounds_offset: [0, 1.5, 0],
                    },
                    bones: finalBones,
                },
            ],
        };
    }

    function stopJobPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startJobPolling(jobId) {
        stopJobPolling();
        setJobStatus("Build job " + jobId + ": running...", true);
        pollTimer = setInterval(async () => {
            try {
                const res = await apiRequest("/api/jobs/" + encodeURIComponent(jobId));
                const job = res.job || {};
                setJobStatus("Job [" + (job.step || job.status) + "]: " + (job.message || ""), true);
                if (job.status === "done") {
                    stopJobPolling();
                    setStatus("synced & built (v" + (job.version || "?") + ")");
                    fetchCatalog();
                } else if (job.status === "error") {
                    stopJobPolling();
                    setStatus("build error: " + (job.error || "unknown"));
                }
            } catch (err) {
                stopJobPolling();
                setJobStatus("Poll error: " + err.message, true);
            }
        }, 1500);
    }

    async function publishCosmetic() {
        const name = (nameInput?.value || "").trim();
        if (!name) {
            setStatus("isi nama kosmetik dlu");
            return;
        }
        if (!activeCosmetic.rawGeo) {
            setStatus("load atau import model kosmetik dlu");
            return;
        }
        activeCosmetic.name = name;
        activeCosmetic.category = categorySelect?.value || "Wing";
        activeCosmetic.attachmentBone = attachSelect?.value || "body";
        const slug = activeCosmetic.isExisting && activeCosmetic.slug ? activeCosmetic.slug : slugify(name);

        const payload = {
            id: slug,
            name,
            category: activeCosmetic.category,
            attachment_bone: activeCosmetic.attachmentBone,
            color_layers: activeCosmetic.colorLayers,
            geometry: collectEditedCosmeticGeometry(),
            textured: Boolean(activeCosmetic.partMapDataUrl),
            part_map_png: activeCosmetic.partMapDataUrl || undefined,
            texture_png: activeCosmetic.textureDataUrl || undefined,
            optimize: true,
            build_assets: true,
        };

        if (publishBtn) publishBtn.disabled = true;
        setStatus("publishing " + name + "...");
        setJobStatus("Mengirim model ke server Altay...", true);
        try {
            const res = await apiRequest("/api/publish", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            activeCosmetic.slug = res.id || slug;
            activeCosmetic.isExisting = true;
            setStatus("published " + name + " (" + res.before_cubes + " -> " + res.after_cubes + " cubes)");
            if (res.job_id) {
                startJobPolling(res.job_id);
            } else {
                setJobStatus("Live sync selesai tanpa rebuild pack", true);
                fetchCatalog();
            }
        } catch (err) {
            setStatus("publish error: " + err.message);
            setJobStatus("Publish gagal: " + err.message, true);
        } finally {
            updateButtons();
        }
    }

    async function deleteCosmetic() {
        if (!activeCosmetic.slug || !activeCosmetic.isExisting) return;
        if (!window.confirm("Hapus atau nonaktifkan kosmetik '" + activeCosmetic.name + "' dari server?")) return;
        setStatus("deleting " + activeCosmetic.slug + "...");
        try {
            const res = await apiRequest("/api/item/" + encodeURIComponent(activeCosmetic.slug), {
                method: "DELETE",
            });
            setStatus("deleted " + activeCosmetic.slug);
            if (res.job_id) startJobPolling(res.job_id);
            resetForNewCosmetic();
            fetchCatalog();
        } catch (err) {
            setStatus("delete error: " + err.message);
        }
    }

    async function triggerServerSync() {
        setStatus("syncing server...");
        try {
            const res = await apiRequest("/api/sync", { method: "POST", body: JSON.stringify({}) });
            setStatus(res.message || "server synced");
        } catch (err) {
            setStatus("sync error: " + err.message);
        }
    }

    // event listener UI Cosmetics Studio
    connectBtn?.addEventListener("click", fetchCatalog);
    refreshBtn?.addEventListener("click", fetchCatalog);
    newBtn?.addEventListener("click", resetForNewCosmetic);
    syncBtn?.addEventListener("click", triggerServerSync);
    publishBtn?.addEventListener("click", publishCosmetic);
    deleteBtn?.addEventListener("click", deleteCosmetic);

    categoryTabs?.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".studio-cat-tab");
        if (!btn) return;
        activeCategoryFilter = btn.dataset.cat || "ALL";
        categoryTabs.querySelectorAll(".studio-cat-tab").forEach((el) => {
            el.classList.toggle("is-active", el === btn);
        });
        renderCatalogList();
    });

    categorySelect?.addEventListener("change", () => {
        activeCosmetic.category = categorySelect.value;
        const defaultAttach = { Wing: "jacket", Cap: "head", Tail: "jacket", Tool: "leftArm" }[activeCosmetic.category];
        if (!activeCosmetic.isExisting && attachSelect && defaultAttach) {
            setAttachSelectValue(defaultAttach);
            activeCosmetic.attachmentBone = defaultAttach;
        }
        if (activeCosmetic.rawGeo) {
            refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
        }
    });

    attachSelect?.addEventListener("change", () => {
        activeCosmetic.attachmentBone = attachSelect.value;
        if (activeCosmetic.rawGeo) {
            refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
        }
    });

    addColorBtn?.addEventListener("click", () => {
        if (activeCosmetic.colorLayers.length >= 6) return;
        const defaults = [
            [0, 170, 255],
            [255, 255, 255],
            [255, 216, 0],
            [164, 48, 232],
            [0, 191, 72],
            [255, 48, 48],
        ];
        activeCosmetic.colorLayers.push(defaults[activeCosmetic.colorLayers.length % defaults.length]);
        renderColorLayerInputs();
        if (activeCosmetic.rawGeo) {
            refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
        }
    });

    removeColorBtn?.addEventListener("click", () => {
        if (activeCosmetic.colorLayers.length <= 1) return;
        activeCosmetic.colorLayers.pop();
        renderColorLayerInputs();
        if (activeCosmetic.rawGeo) {
            refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
        }
    });

    modelFileInput?.addEventListener("change", async () => {
        const file = modelFileInput.files?.[0];
        if (!file) return;
        try {
            const rawText = await readFileAsText(file);
            const parsed = JSON.parse(rawText);
            let geo = parsed;
            let embeddedTex = null;
            if (parsed && parsed.outliner && parsed.elements) {
                const conv = convertBbmodelToBedrockGeometry(parsed);
                geo = conv.geometry;
                embeddedTex = conv.embeddedTexture;
            }
            activeCosmetic.rawGeo = geo;
            if (!activeCosmetic.isExisting && nameInput && !nameInput.value.trim()) {
                const guessName = file.name
                    .replace(/\.(bbmodel|geo\.json|json)$/i, "")
                    .replace(/[_-]+/g, " ")
                    .replace(/\b\w/g, (ch) => ch.toUpperCase());
                nameInput.value = guessName;
                activeCosmetic.name = guessName;
            }
            if (embeddedTex && !activeCosmetic.partMapDataUrl) {
                activeCosmetic.textureDataUrl = embeddedTex;
            }
            if (modelFileLabel) modelFileLabel.textContent = file.name;
            await refreshCosmeticPreview({ preserveCamera: false, preservePanels: true });
            setStatus("imported " + file.name);
        } catch (err) {
            setStatus("import error: " + err.message);
        }
    });

    textureFileInput?.addEventListener("change", async () => {
        const file = textureFileInput.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (file.name.toLowerCase().includes("part_map")) {
                activeCosmetic.partMapDataUrl = dataUrl;
                activeCosmetic.textured = true;
            } else {
                activeCosmetic.textureDataUrl = dataUrl;
            }
            if (textureFileLabel) textureFileLabel.textContent = file.name;
            if (activeCosmetic.rawGeo) {
                await refreshCosmeticPreview({ preserveCamera: true, preservePanels: true, preserveSelection: true });
            }
            setStatus("loaded texture " + file.name);
        } catch (err) {
            setStatus("texture error: " + err.message);
        }
    });

    // baca parameter URL studio sama token lalu bersihin token dari address bar biar aman
    function applyStudioParamsFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const studioUrl = params.get("studio") || params.get("studioUrl");
        const token = params.get("token") || params.get("studioToken");
        const isLocalStudioHost = window.location.pathname.startsWith("/cosmetics-studio");
        if (urlInput) {
            urlInput.value = studioUrl || (isLocalStudioHost ? window.location.origin + "/cosmetics-studio" : DEFAULT_STUDIO_URL);
        }
        if (token && tokenInput) {
            tokenInput.value = token;
            params.delete("token");
            params.delete("studioToken");
            const qs = params.toString();
            const cleanUrl = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
            window.history.replaceState({}, document.title, cleanUrl);
        }
        renderColorLayerInputs();
        updateButtons();
        if (studioUrl || token || isLocalStudioHost) {
            panel.open = true;
            if (token) {
                fetchCatalog();
            }
        }
    }

    applyStudioParamsFromUrl();
    return { fetchCatalog, loadCatalogItem };
}

