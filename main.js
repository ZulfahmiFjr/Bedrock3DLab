import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
// import { DragControls } from "three/addons/controls/DragControls.js";

const boneMenuContainer = document.getElementById("bone-menu-container");
const boneList = document.getElementById("bone-list");
const boneMenuToggle = document.getElementById("bone-menu-toggle");
const closeBonePanelBtn = document.getElementById("close-bone-panel");
const relayUrlInput = document.getElementById("relayUrlInput");
const relayServerIdInput = document.getElementById("relayServerIdInput");
const relayPairCodeInput = document.getElementById("relayPairCodeInput");
const relayConnectBtn = document.getElementById("relayConnectBtn");
const relayDisconnectBtn = document.getElementById("relayDisconnectBtn");
const relayStatusText = document.getElementById("relayStatusText");
const relayPayloadInfo = document.getElementById("relayPayloadInfo");
const relayPayloadPlayer = document.getElementById("relayPayloadPlayer");
const relayPayloadSkinId = document.getElementById("relayPayloadSkinId");
const relayPayloadTextureSize = document.getElementById("relayPayloadTextureSize");
const relayPayloadGeometry = document.getElementById("relayPayloadGeometry");
const relayPlayersInfo = document.getElementById("relayPlayersInfo");
const relayPlayersCount = document.getElementById("relayPlayersCount");
const relayPlayersList = document.getElementById("relayPlayersList");

let bedrock3dRelaySocket = null;
let relayPlayersSnapshot = [];
let boneMap = new Map();
const undoStack = [];
const redoStack = [];
let actionInProgress = null;

function main() {
    const canvas = document.querySelector("#c");
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        canvas,
        preserveDrawingBuffer: true,
        alpha: true,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    renderer.setPixelRatio(window.devicePixelRatio);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333333);

    const axesScene = new THREE.Scene();
    const axesCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    axesCamera.position.set(0, 0, 10);
    axesCamera.lookAt(0, 0, 0);
    const axesHelperObject = createCustomGizmo();
    axesScene.add(axesHelperObject);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 16, 40);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.update();

    const ambientLight = new THREE.AmbientLight(0xffffff, 2.0);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 2.5);
    directionalLight.position.set(10, 20, 15);
    scene.add(directionalLight);
    const gridHelper = new THREE.GridHelper(32, 32, 0x888888, 0x444444);
    scene.add(gridHelper);

    const largeGridHelper = new THREE.GridHelper(160, 10, 0x555555, 0x333333);
    scene.add(largeGridHelper);

    const modelContainer = new THREE.Group();
    modelContainer.scale.set(1, 1, 1);
    //modelContainer.rotation.z = Math.PI;
    scene.add(modelContainer);

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let draggableObjects = [];
    let selectionBoxHelper = null;
    let selectedBoneName = null;
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode("translate");
    transformControls.setSpace("local");
    transformControls.setTranslationSnap(1);
    transformControls.setRotationSnap(THREE.MathUtils.degToRad(15));
    transformControls.setScaleSnap(0.1);
    scene.add(transformControls);
    let currentTransformMode = "translate";
    let currentTransformSpace = "local";

    transformControls.addEventListener("dragging-changed", function (event) {
        controls.enabled = !event.value;
    });

    transformControls.addEventListener("objectChange", function () {
        if (!transformControls.object) return;
        if (currentTransformMode === "translate") {
            transformControls.object.position.x = Math.round(transformControls.object.position.x);
            transformControls.object.position.y = Math.round(transformControls.object.position.y);
            transformControls.object.position.z = Math.round(transformControls.object.position.z);
        }
    });

    transformControls.addEventListener("mouseDown", function () {
        const object = transformControls.object;
        if (object) {
            actionInProgress = {
                boneName: object.name,
                oldState: {
                    position: object.position.clone(),
                    quaternion: object.quaternion.clone(),
                    scale: object.scale.clone(),
                },
            };
        }
    });

    transformControls.addEventListener("mouseUp", function () {
        if (actionInProgress) {
            const object = boneMap.get(actionInProgress.boneName);
            if (object) {
                const oldState = actionInProgress.oldState;
                const changed =
                    !object.position.equals(oldState.position) ||
                    !object.quaternion.equals(oldState.quaternion) ||
                    !object.scale.equals(oldState.scale);
                if (changed) {
                    undoStack.push(actionInProgress);
                    redoStack.length = 0;
                }
            }
            actionInProgress = null;
        }
    });

    function setTransformMode(mode) {
        if (!["translate", "rotate", "scale"].includes(mode)) return;
        currentTransformMode = mode;
        transformControls.setMode(mode);
        console.log(`Transform mode: ${mode}`);
    }

    function toggleTransformSpace() {
        currentTransformSpace = currentTransformSpace === "local" ? "world" : "local";
        transformControls.setSpace(currentTransformSpace);
        console.log(`Transform space: ${currentTransformSpace}`);
    }

    function deselectBone() {
        transformControls.detach();
        selectedBoneName = null;
        if (selectionBoxHelper) {
            scene.remove(selectionBoxHelper);
            selectionBoxHelper.dispose();
            selectionBoxHelper = null;
        }
        document.querySelectorAll(".bone-item.active").forEach((item) => item.classList.remove("active"));
    }

    window.addEventListener("pointerdown", function (event) {
        if (transformControls.dragging === true) return;
        if (event.target !== renderer.domElement) return;
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(modelContainer.children, true);
        if (intersects.length > 0) {
            let object = intersects[0].object;
            let targetBone = null;
            while (object.parent) {
                if (draggableObjects.includes(object)) {
                    targetBone = object;
                    break;
                }
                object = object.parent;
            }
            if (targetBone) {
                // recenterPivot(targetBone);
                // transformControls.attach(targetBone);
                // if (selectionBoxHelper) scene.remove(selectionBoxHelper);
                // selectionBoxHelper = new THREE.BoxHelper(targetBone, 0xffff00);
                // scene.add(selectionBoxHelper);
                selectBoneByName(targetBone.name);
            }
        } else {
            if (transformControls.object) {
                deselectBone();
            }
        }
    });

    window.addEventListener("keydown", function (event) {
        const key = event.key.toLowerCase();
        // hindari shortcut aktif saat user sedang mengetik di input/select/button
        const tagName = event.target.tagName?.toLowerCase();
        const isTypingTarget =
            tagName === "input" ||
            tagName === "select" ||
            tagName === "textarea" ||
            event.target.isContentEditable;
        if (isTypingTarget) return;
        if (event.ctrlKey && key === "z") {
            event.preventDefault();
            undo();
            return;
        }
        if (event.ctrlKey && key === "y") {
            event.preventDefault();
            redo();
            return;
        }
        if (key === "w") {
            event.preventDefault();
            setTransformMode("translate");
            return;
        }
        if (key === "e") {
            event.preventDefault();
            setTransformMode("rotate");
            return;
        }
        if (key === "r") {
            event.preventDefault();
            setTransformMode("scale");
            return;
        }
        if (key === "q") {
            event.preventDefault();
            toggleTransformSpace();
            return;
        }
        if (key === "escape") {
            event.preventDefault();
            deselectBone();
            return;
        }
    });

    // let selectionBoxHelper = null;
    // let dragControls;
    // function initDragControls(draggableObjects) {
    //     if (dragControls) {
    //         dragControls.deactivate();
    //         dragControls.dispose();
    //     }
    //     dragControls = new DragControls(draggableObjects, camera, renderer.domElement);
    //     dragControls.addEventListener("dragstart", function (event) {
    //         controls.enabled = false;
    //         if (selectionBoxHelper) {
    //             scene.remove(selectionBoxHelper);
    //             selectionBoxHelper.dispose();
    //         }
    //         selectionBoxHelper = new THREE.BoxHelper(event.object, 0xffff00); // warna kuning
    //         scene.add(selectionBoxHelper);
    //     });
    //     dragControls.addEventListener("dragend", function (event) {
    //         controls.enabled = true;
    //         if (selectionBoxHelper) {
    //             scene.remove(selectionBoxHelper);
    //             selectionBoxHelper.dispose();
    //             selectionBoxHelper = null;
    //         }
    //     });

    //     dragControls.addEventListener("drag", function (event) {
    //         event.object.position.x = Math.round(event.object.position.x);
    //         event.object.position.y = Math.round(event.object.position.y);
    //         event.object.position.z = Math.round(event.object.position.z);
    //         if (selectionBoxHelper) {
    //             selectionBoxHelper.update();
    //         }
    //     });
    // }

    const jsonInput = document.getElementById("jsonFile");
    const textureInput = document.getElementById("textureFile");
    const loadBtn = document.getElementById("loadBtn");
    const exportJsonBtn = document.getElementById("exportJsonBtn");
    const jsonFileLabel = document.getElementById("jsonFile-label");
    const textureFileLabel = document.getElementById("textureFile-label");
    const controlsPanel = document.getElementById("controls-panel");
    const menuToggleBtn = document.getElementById("menu-toggle");
    const closeControlsBtn = document.getElementById("close-controls");
    const geometrySelectorGroup = document.getElementById("geometry-selector-group");
    const geometrySelector = document.getElementById("geometrySelector");

    let modelData = null;
    let textureDataURL = null;
    let loadedJsonFileName = "model.json";
    let activeGeometryIndex = null;
    let activeGeometryIdentifier = "geometry";

    const SAMPLE_MODELS = {
        boat: {
            json: "assets/boat.json",
            texture: "assets/boat.png",
            displayName: "Boat",
        },
        player: {
            json: "assets/player.json",
            texture: "assets/player.png",
            displayName: "Player",
        },
        sniffer: {
            json: "assets/sniffer.json",
            texture: "assets/sniffer.png",
            displayName: "Sniffer",
        },
    };
    const DEFAULT_PLAYER_GEOMETRY_URL = "assets/players.json";

    function getRequestedSampleModel() {
        const params = new URLSearchParams(window.location.search);
        const queryModel = params.get("model") || params.get("sample");
        if (queryModel) {
            return queryModel.toLowerCase();
        }
        const pathParts = window.location.pathname.split("/").filter(Boolean);
        const lastPath = pathParts[pathParts.length - 1]?.toLowerCase();
        if (SAMPLE_MODELS[lastPath]) {
            return lastPath;
        }
        return null;
    }

    async function autoLoadSampleModel(modelKey) {
        const sample = SAMPLE_MODELS[modelKey];
        if (!sample) return;
        try {
            jsonFileLabel.textContent = `${sample.displayName}.json`;
            textureFileLabel.textContent = `${sample.displayName}.png`;
            loadedJsonFileName = `${modelKey}.json`;
            activeGeometryIndex = null;
            activeGeometryIdentifier = "geometry";
            const jsonResponse = await fetch(sample.json);
            if (!jsonResponse.ok) {
                throw new Error(`Failed to load ${sample.json}: ${jsonResponse.status}`);
            }
            modelData = await jsonResponse.json();
            // TextureLoader bisa menerima URL string langsung, jadi gak perlu convert PNG ke dataURL
            textureDataURL = sample.texture;
            const geometries = modelData["minecraft:geometry"];
            if (!geometries || geometries.length === 0) {
                alert("Sample model tidak berisi data geometri yang valid.");
                return;
            }
            if (geometries.length === 1) {
                geometrySelectorGroup.classList.add("hidden");
                geometrySelectorGroup.style.display = "none";
                geometrySelector.innerHTML = "";
                await loadAndRender(geometries[0], textureDataURL, 0);
            } else {
                populateGeometrySelector(geometries);
                geometrySelectorGroup.classList.remove("hidden");
                geometrySelectorGroup.style.display = "block";
            }
            console.log(`Auto-loaded sample model: ${modelKey}`);
        } catch (error) {
            console.error("Gagal auto-load sample model:", error);
            alert(`Gagal memuat sample model: ${modelKey}`);
        }
    }

    function decodeBase64ToUint8Array(base64) {
        const cleanBase64 = String(base64 || "").trim();
        if (!cleanBase64) {
            throw new Error("skinData kosong.");
        }
        const binary = atob(cleanBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function detectBedrockSkinSize(byteLength) {
        if (byteLength === 8192) {
            return {
                sourceWidth: 64,
                sourceHeight: 32,
                canvasWidth: 64,
                canvasHeight: 64,
            };
        }
        if (byteLength === 16384) {
            return {
                sourceWidth: 64,
                sourceHeight: 64,
                canvasWidth: 64,
                canvasHeight: 64,
            };
        }
        if (byteLength === 65536) {
            return {
                sourceWidth: 128,
                sourceHeight: 128,
                canvasWidth: 128,
                canvasHeight: 128,
            };
        }
        throw new Error(`Ukuran skinData tidak didukung: ${byteLength} bytes.`);
    }

    function skinDataBase64ToPngDataUrl(skinDataBase64) {
        const rgbaBytes = decodeBase64ToUint8Array(skinDataBase64);
        const skinSize = detectBedrockSkinSize(rgbaBytes.byteLength);
        console.log("[Bedrock3DLab Relay] Decoded skinData:", {
            byteLength: rgbaBytes.byteLength,
            sourceWidth: skinSize.sourceWidth,
            sourceHeight: skinSize.sourceHeight,
            canvasWidth: skinSize.canvasWidth,
            canvasHeight: skinSize.canvasHeight,
        });
        const canvas = document.createElement("canvas");
        canvas.width = skinSize.canvasWidth;
        canvas.height = skinSize.canvasHeight;
        const context = canvas.getContext("2d");
        if (!context) {
            throw new Error("Canvas 2D context tidak tersedia.");
        }
        const imageData = new ImageData(
            new Uint8ClampedArray(rgbaBytes),
            skinSize.sourceWidth,
            skinSize.sourceHeight
        );
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.putImageData(imageData, 0, 0);
        return {
            dataUrl: canvas.toDataURL("image/png"),
            width: skinSize.canvasWidth,
            height: skinSize.canvasHeight,
            sourceWidth: skinSize.sourceWidth,
            sourceHeight: skinSize.sourceHeight,
            byteLength: rgbaBytes.byteLength,
        };
    }

    async function loadGeometryJsonForSkinResponse(data) {
        const geometryData = data.geometryData;
        if (typeof geometryData === "string" && geometryData.trim() !== "") {
            try {
                return JSON.parse(geometryData);
            } catch (error) {
                throw new Error("geometryData ada, tapi bukan JSON valid.");
            }
        }
        const response = await fetch(DEFAULT_PLAYER_GEOMETRY_URL);
        if (!response.ok) {
            throw new Error(`Gagal load default player geometry: ${response.status}`);
        }
        return await response.json();
    }

    function getPreferredGeometryNameForSkinResponse(data) {
        const geometryName = String(data.geometryName || "").trim();
        const skinId = String(data.skinId || "").trim();
        if (geometryName) {
            return geometryName;
        }
        if (skinId.toLowerCase().includes("slim")) {
            return "geometry.humanoid.customSlim";
        }
        return "geometry.humanoid.custom";
    }

    function findGeometryIndexForSkinResponse(geometries, data) {
        if (!Array.isArray(geometries) || geometries.length === 0) {
            throw new Error("Geometry JSON tidak punya minecraft:geometry yang valid.");
        }
        const preferredGeometryName = getPreferredGeometryNameForSkinResponse(data);
        const exactMatchIndex = geometries.findIndex((geo) => {
            const identifier = geo.description?.identifier || "";
            const geometryName = geo.description?.geometry_name || "";
            return identifier === preferredGeometryName || geometryName === preferredGeometryName;
        });
        if (exactMatchIndex >= 0) {
            return exactMatchIndex;
        }
        const classicFallbackIndex = geometries.findIndex((geo) => {
            const identifier = geo.description?.identifier || "";
            const geometryName = geo.description?.geometry_name || "";
            return identifier === "geometry.humanoid.custom" || geometryName === "geometry.humanoid.custom";
        });
        if (classicFallbackIndex >= 0) {
            return classicFallbackIndex;
        }
        const firstNonCapeIndex = geometries.findIndex((geo) => {
            const identifier = geo.description?.identifier || "";
            const geometryName = geo.description?.geometry_name || "";
            return identifier !== "geometry.cape" && geometryName !== "geometry.cape";
        });
        return firstNonCapeIndex >= 0 ? firstNonCapeIndex : 0;
    }

    jsonInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        if (!file) return;
        jsonFileLabel.textContent = file.name;
        loadedJsonFileName = file.name;
        activeGeometryIndex = null;
        activeGeometryIdentifier = "geometry";
        geometrySelectorGroup.classList.add("hidden");
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                modelData = JSON.parse(e.target.result);
                console.log("File model.json berhasil diparsing.");
            } catch (err) {
                alert("Error: File JSON tidak valid.");
                modelData = null;
            }
        };
        reader.readAsText(file);
    });

    textureInput.addEventListener("change", (event) => {
        const file = event.target.files[0];
        if (!file) return;
        textureFileLabel.textContent = file.name;
        const reader = new FileReader();
        reader.onload = (e) => (textureDataURL = e.target.result);
        reader.readAsDataURL(file);
    });

    loadBtn.addEventListener("click", () => {
        if (!modelData || !textureDataURL) {
            alert("Harap pilih file model.json dan texture.png terlebih dahulu.");
            return;
        }
        const geometries = modelData["minecraft:geometry"];
        if (!geometries || geometries.length === 0) {
            alert("File JSON tidak berisi data geometri yang valid.");
            return;
        }
       if (geometries.length === 1) {
            geometrySelectorGroup.classList.add("hidden");
            geometrySelectorGroup.style.display = "none";
            geometrySelector.innerHTML = "";
            loadAndRender(geometries[0], textureDataURL, 0);
        } else {
            populateGeometrySelector(geometries);
            geometrySelectorGroup.classList.remove("hidden");
            geometrySelectorGroup.style.display = "block";
            // gak pake alert di sini, supaya dropdown langsung kelihatan
            console.log(`File ini berisi ${geometries.length} geometry. Silakan pilih dari dropdown.`);
        }
    });

    function populateGeometrySelector(geometries) {
        geometrySelector.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = `-- Select Model (${geometries.length} found) --`;
        placeholder.disabled = true;
        placeholder.selected = true;
        geometrySelector.appendChild(placeholder);
        geometries.forEach((geo, index) => {
            const identifier =
                geo.description?.identifier ||
                geo.description?.geometry_name ||
                `No Name ${index + 1}`;
            const option = document.createElement("option");
            option.value = index;
            option.textContent = `${index + 1}. ${identifier}`;
            geometrySelector.appendChild(option);
        });
        geometrySelector.onchange = (event) => {
            const selectedIndex = Number(event.target.value);
            if (!Number.isInteger(selectedIndex)) return;
            if (!geometries[selectedIndex]) return;
            const selectedGeo = geometries[selectedIndex];
            // pake textureDataURL, bukan textureUrl.
            loadAndRender(selectedGeo, textureDataURL, selectedIndex);
        };
    }

    function populateBoneMenu(bonesData) {
        const boneTree = [];
        const map = new Map();
        bonesData.forEach((bone) => {
            map.set(bone.name, { ...bone, children: [] });
        });
        map.forEach((boneNode) => {
            if (boneNode.parent && map.has(boneNode.parent)) {
                map.get(boneNode.parent).children.push(boneNode);
            } else {
                boneTree.push(boneNode);
            }
        });
        boneList.innerHTML = "";
        createBoneElements(boneTree, boneList, 0);
    }

    function createBoneElements(bones, parentElement, level) {
        const basePadding = 12;
        const indentPerLevel = 15;
        bones.forEach((bone) => {
            const boneItem = document.createElement("div");
            boneItem.className = "bone-item";
            boneItem.textContent = bone.name;
            boneItem.style.paddingLeft = basePadding + level * indentPerLevel + "px";
            boneItem.addEventListener("click", () => {
                selectBoneByName(bone.name);
            });
            parentElement.appendChild(boneItem);
            if (bone.children.length > 0) {
                createBoneElements(bone.children, parentElement, level + 1);
            }
        });
    }

    function selectBoneByName(boneName) {
        const targetBone = boneMap.get(boneName);
        if (!targetBone) return;
        // jangan recenter pivot saat select, bone pivot sudah berasal dari data JSON, jadi select tidak boleh mengubah struktur model.
        selectedBoneName = boneName;
        transformControls.attach(targetBone);
        if (selectionBoxHelper) {
            scene.remove(selectionBoxHelper);
            selectionBoxHelper.dispose();
            selectionBoxHelper = null;
        }
        selectionBoxHelper = new THREE.BoxHelper(targetBone, 0xffff00);
        scene.add(selectionBoxHelper);
        document.querySelectorAll(".bone-item").forEach((item) => {
            item.classList.toggle("active", item.textContent === boneName);
        });
    }

    // geometrySelector.addEventListener("change", (event) => {
    //     const selectedIndex = event.target.value;
    //     if (selectedIndex !== "") {
    //         const selectedGeo = modelData["minecraft:geometry"][selectedIndex];
    //         loadAndRender(selectedGeo);
    //     }
    // });

    // async function loadAndRender(geo, textureUrl) {
    //     if (!geo || !textureUrl) return;
    //     const bones = await loadModelAndTexture(modelContainer, geo, textureUrl, camera, controls);
    //     initDragControls(bones);
    //     controlsPanel.classList.add("hidden");
    //     menuToggleBtn.classList.remove("hidden");
    // }

    async function loadAndRender(geo, textureUrl, geometryIndex = null) {
        if (!geo || !textureUrl) return;
        activeGeometryIndex = geometryIndex;
        activeGeometryIdentifier =
            geo.description?.identifier ||
            geo.description?.geometry_name ||
            `geometry_${geometryIndex ?? 0}`;
        deselectBone();
        const bones = await loadModelAndTexture(modelContainer, geo, textureUrl, camera, controls);
        draggableObjects = bones;
        if (geo.bones && geo.bones.length > 0) {
            populateBoneMenu(geo.bones);
            boneMenuToggle.classList.remove("hidden");
        }
        if (!controlsPanel.classList.contains("hidden")) {
            controlsPanel.classList.add("hidden");
            menuToggleBtn.classList.remove("hidden");
        }
    }

    menuToggleBtn.addEventListener("click", () => {
        controlsPanel.classList.remove("hidden");
        menuToggleBtn.classList.add("hidden");
    });

    closeControlsBtn.addEventListener("click", () => {
        controlsPanel.classList.add("hidden");
        menuToggleBtn.classList.remove("hidden");
    });

    boneMenuToggle.addEventListener("click", () => {
        boneMenuContainer.classList.remove("hidden");
        boneMenuToggle.classList.add("hidden");
    });

    closeBonePanelBtn.addEventListener("click", () => {
        boneMenuContainer.classList.add("hidden");
        boneMenuToggle.classList.remove("hidden");
    });

    // loadModelAndTexture(modelContainer);

    function cleanNumber(value, precision = 4) {
        const factor = Math.pow(10, precision);
        const rounded = Math.round(value * factor) / factor;
        return Object.is(rounded, -0) ? 0 : rounded;
    }

    function normalizeDegrees(degrees) {
        let normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
        return cleanNumber(normalized);
    }

    function deepClone(value) {
        if (typeof structuredClone === "function") {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    }

    function makeSafeFileName(value) {
        return String(value || "geometry")
            .replace(/\.json$/i, "")
            .replace(/[^\w.-]+/g, "_");
    }

    function downloadJsonFile(data, fileName) {
        const jsonString = JSON.stringify(data, null, 4);
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
    }

    function exportEditedJson() {
        if (!modelData) {
            alert("Belum ada file JSON yang diload.");
            return;
        }
        if (activeGeometryIndex === null) {
            alert("Belum ada geometry aktif. Load atau pilih model dulu.");
            return;
        }
        const geometries = modelData["minecraft:geometry"];
        if (!geometries || !geometries[activeGeometryIndex]) {
            alert("Geometry aktif tidak ditemukan.");
            return;
        }
        const exportedData = deepClone(modelData);
        const exportedGeo = exportedData["minecraft:geometry"][activeGeometryIndex];
        if (!exportedGeo.bones || exportedGeo.bones.length === 0) {
            alert("Geometry aktif tidak punya bones.");
            return;
        }
        const bonesByName = new Map();
        const originalPivotByName = new Map();
        const exportedPivotCache = new Map();
        let hasUnsupportedScale = false;
        exportedGeo.bones.forEach((bone) => {
            bonesByName.set(bone.name, bone);
            originalPivotByName.set(bone.name, [...(bone.pivot || [0, 0, 0])]);
        });

        function hasDelta(delta) {
            return delta.some((value) => Math.abs(value) > 0.0001);
        }

        function shiftVector3Array(vector, delta) {
            if (!Array.isArray(vector) || vector.length < 3) return;
            vector[0] = cleanNumber(vector[0] + delta[0]);
            vector[1] = cleanNumber(vector[1] + delta[1]);
            vector[2] = cleanNumber(vector[2] + delta[2]);
        }

        function shiftLocators(locators, delta) {
            if (!locators || typeof locators !== "object") return;
            Object.values(locators).forEach((locator) => {
                if (Array.isArray(locator)) {
                    shiftVector3Array(locator, delta);
                    return;
                }
                if (locator && typeof locator === "object") {
                    if (Array.isArray(locator.offset)) {
                        shiftVector3Array(locator.offset, delta);
                    }
                    if (Array.isArray(locator.pivot)) {
                        shiftVector3Array(locator.pivot, delta);
                    }
                }
            });
        }

        function shiftBoneGeometryData(bone, delta) {
            if (!hasDelta(delta)) return;
            if (bone.cubes) {
                bone.cubes.forEach((cube) => {
                    if (Array.isArray(cube.origin)) {
                        shiftVector3Array(cube.origin, delta);
                    }
                    // untuk cube yg punya percube rotation.
                    if (Array.isArray(cube.pivot)) {
                        shiftVector3Array(cube.pivot, delta);
                    }
                });
            }
            shiftLocators(bone.locators, delta);
        }

        function getExportedPivot(bone) {
            if (exportedPivotCache.has(bone.name)) {
                return exportedPivotCache.get(bone.name);
            }
            const object = boneMap.get(bone.name);
            if (!object) {
                const fallbackPivot = [...(bone.pivot || [0, 0, 0])];
                exportedPivotCache.set(bone.name, fallbackPivot);
                return fallbackPivot;
            }
            let pivot;
            if (bone.parent && bonesByName.has(bone.parent)) {
                const parentBone = bonesByName.get(bone.parent);
                const parentPivot = getExportedPivot(parentBone);
                // kebalikan dari rumus import parent-child:
                // object.position = parentPivot - childPivot untuk X,
                // object.position = childPivot - parentPivot untuk Y/Z.
                pivot = [
                    parentPivot[0] - object.position.x,
                    object.position.y + parentPivot[1],
                    object.position.z + parentPivot[2],
                ];
            } else {
                // kebalikan dari rumus root bone saat import:
                // Three.js X adalah hasil flip dari Bedrock X.
                pivot = [
                    -object.position.x,
                    object.position.y,
                    object.position.z,
                ];
            }
            pivot = pivot.map((value) => cleanNumber(value));
            exportedPivotCache.set(bone.name, pivot);
            return pivot;
        }

        exportedGeo.bones.forEach((bone) => {
            const object = boneMap.get(bone.name);
            if (!object) return;
            const originalPivot = originalPivotByName.get(bone.name) || [0, 0, 0];
            const exportedPivot = getExportedPivot(bone);
            const pivotDelta = [
                cleanNumber(exportedPivot[0] - originalPivot[0]),
                cleanNumber(exportedPivot[1] - originalPivot[1]),
                cleanNumber(exportedPivot[2] - originalPivot[2]),
            ];
            // pivot diganti.
            bone.pivot = exportedPivot;
            // origin cube, cube pivot, dan locator juga harus ikut geser.
            // kalo gak, hasil reload akan beda dari tampilan editor.
            shiftBoneGeometryData(bone, pivotDelta);
            // kebalikan dari rumus import rotation:
            // Three.js = [-bedrockX, -bedrockY, bedrockZ]
            const rotation = [
                normalizeDegrees(-THREE.MathUtils.radToDeg(object.rotation.x)),
                normalizeDegrees(-THREE.MathUtils.radToDeg(object.rotation.y)),
                normalizeDegrees(THREE.MathUtils.radToDeg(object.rotation.z)),
            ];
            const hasRotation = rotation.some((value) => Math.abs(value) > 0.0001);
            if (hasRotation) {
                bone.rotation = rotation;
            } else {
                delete bone.rotation;
            }
            const scaleChanged =
                Math.abs(object.scale.x - 1) > 0.0001 ||
                Math.abs(object.scale.y - 1) > 0.0001 ||
                Math.abs(object.scale.z - 1) > 0.0001;
            if (scaleChanged) {
                hasUnsupportedScale = true;
            }
        });
        const baseName = makeSafeFileName(loadedJsonFileName);
        const geoName = makeSafeFileName(activeGeometryIdentifier);
        const fileName = `${baseName}_${geoName}_edited.json`;
        downloadJsonFile(exportedData, fileName);
        if (hasUnsupportedScale) {
            alert(
                "Export selesai, tapi ada bone yang memakai scale. Scale belum diexport ke format Bedrock geometry. Untuk scale, nanti perlu fitur bake scale into cubes."
            );
        }
    }

    function takeScreenshot() {
        const originalBackground = scene.background ? scene.background.clone() : null;
        const originalClearColor = renderer.getClearColor(new THREE.Color()).clone();
        const originalClearAlpha = renderer.getClearAlpha();
        const gridVisible = gridHelper.visible;
        const largeGridVisible = largeGridHelper.visible;
        const transformControlsVisible = transformControls.visible;
        const selectionBoxVisible = selectionBoxHelper ? selectionBoxHelper.visible : null;
        try {
            // sembunyiin semua helper/editor object.
            gridHelper.visible = false;
            largeGridHelper.visible = false;
            transformControls.visible = false;
            if (selectionBoxHelper) {
                selectionBoxHelper.visible = false;
            }
            // background transparan untuk screenshot.
            scene.background = null;
            renderer.setClearColor(0x000000, 0);
            renderer.setClearAlpha(0);
            // paksa viewport full canvas, bukan viewport kecil gizmo.
            const canvasSize = renderer.getSize(new THREE.Vector2());
            renderer.setViewport(0, 0, canvasSize.x, canvasSize.y);
            renderer.setScissorTest(false);
            // bersihin canvas lama supaya grid/gizmo dari frame sebelumnya tidak ikut.
            renderer.clear(true, true, true);
            // render hanya scene utama dari angle kamera saat ini
            renderer.render(scene, camera);
            const context =
                renderer.domElement.getContext("webgl2", { preserveDrawingBuffer: true }) ||
                renderer.domElement.getContext("webgl", { preserveDrawingBuffer: true });
            const width = context.drawingBufferWidth;
            const height = context.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            context.readPixels(
                0,
                0,
                width,
                height,
                context.RGBA,
                context.UNSIGNED_BYTE,
                pixels
            );
            let top = height;
            let left = width;
            let right = 0;
            let bottom = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const alpha = pixels[(y * width + x) * 4 + 3];
                    if (alpha > 0) {
                        top = Math.min(top, y);
                        left = Math.min(left, x);
                        right = Math.max(right, x);
                        bottom = Math.max(bottom, y);
                    }
                }
            }
            const cropWidth = right - left + 1;
            const cropHeight = bottom - top + 1;
            if (cropWidth <= 0 || cropHeight <= 0) {
                alert("Model tidak terlihat untuk discreenshot.");
                return;
            }
            const imageData = new ImageData(
                new Uint8ClampedArray(pixels),
                width,
                height
            );
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = width;
            tempCanvas.height = height;
            tempCanvas.getContext("2d").putImageData(imageData, 0, 0);
            const cropCanvas = document.createElement("canvas");
            cropCanvas.width = cropWidth;
            cropCanvas.height = cropHeight;
            const cropCtx = cropCanvas.getContext("2d");
            // flip vertikal karena readPixels membaca dari bawah ke atas
            cropCtx.translate(0, cropHeight);
            cropCtx.scale(1, -1);
            cropCtx.drawImage(
                tempCanvas,
                left,
                top,
                cropWidth,
                cropHeight,
                0,
                0,
                cropWidth,
                cropHeight
            );
            const dataURL = cropCanvas.toDataURL("image/png");
            const link = document.createElement("a");
            link.download = "model_screenshot.png";
            link.href = dataURL;
            link.click();
        } finally {
            // restore semua state supaya tampilan editor normal lagi
            gridHelper.visible = gridVisible;
            largeGridHelper.visible = largeGridVisible;
            transformControls.visible = transformControlsVisible;
            if (selectionBoxHelper && selectionBoxVisible !== null) {
                selectionBoxHelper.visible = selectionBoxVisible;
            }
            scene.background = originalBackground;
            renderer.setClearColor(originalClearColor, originalClearAlpha);
            renderer.setClearAlpha(originalClearAlpha);
        }
    }

    exportJsonBtn.addEventListener("click", exportEditedJson);
    const screenshotBtn = document.getElementById("screenshotBtn");
    screenshotBtn.addEventListener("click", takeScreenshot);
    relayConnectBtn?.addEventListener("click", connectBedrock3DRelay);
    relayDisconnectBtn?.addEventListener("click", disconnectBedrock3DRelay);
    const requestedSampleModel = getRequestedSampleModel();
    if (requestedSampleModel) {
        autoLoadSampleModel(requestedSampleModel);
    }

    function animate() {
        requestAnimationFrame(animate);

        if (resizeRendererToDisplaySize(renderer)) {
            const canvas = renderer.domElement;
            camera.aspect = canvas.clientWidth / canvas.clientHeight;
            camera.updateProjectionMatrix();
        }
        if (selectionBoxHelper) {
            selectionBoxHelper.update();
        }

        controls.update();
        renderer.clear();
        const size = renderer.getSize(new THREE.Vector2());
        renderer.setViewport(0, 0, size.x, size.y);
        renderer.render(scene, camera);
        const gizmoSize = 110;
        const padding = 10;
        renderer.clearDepth();
        axesCamera.position.copy(camera.position);
        axesCamera.position.sub(controls.target);
        axesCamera.position.setLength(10);
        axesCamera.lookAt(0, 0, 0);
        renderer.setViewport(
        size.x - gizmoSize - padding, // kanan
        padding, // bawah
        gizmoSize,
        gizmoSize);
        renderer.render(axesScene, axesCamera);
        renderer.setViewport(0, 0, size.x, size.y);
    }

    function setRelayStatus(message) {
        if (relayStatusText) {
            relayStatusText.textContent = `Relay: ${message}`;
        }
    }

    function setRelayPayloadInfo({
        playerName,
        skinId,
        textureSize,
        geometryLabel,
    }) {
        if (!relayPayloadInfo) return;
        if (relayPayloadPlayer) {
            relayPayloadPlayer.textContent = playerName || "-";
            relayPayloadPlayer.title = playerName || "-";
        }
        if (relayPayloadSkinId) {
            relayPayloadSkinId.textContent = skinId || "-";
            relayPayloadSkinId.title = skinId || "-";
        }
        if (relayPayloadTextureSize) {
            relayPayloadTextureSize.textContent = textureSize || "-";
            relayPayloadTextureSize.title = textureSize || "-";
        }
        if (relayPayloadGeometry) {
            relayPayloadGeometry.textContent = geometryLabel || "-";
            relayPayloadGeometry.title = geometryLabel || "-";
        }
        relayPayloadInfo.classList.remove("is-hidden");
    }

    function clearRelayPayloadInfo() {
        if (!relayPayloadInfo) return;
        if (relayPayloadPlayer) relayPayloadPlayer.textContent = "-";
        if (relayPayloadSkinId) relayPayloadSkinId.textContent = "-";
        if (relayPayloadTextureSize) relayPayloadTextureSize.textContent = "-";
        if (relayPayloadGeometry) relayPayloadGeometry.textContent = "-";
        relayPayloadInfo.classList.add("is-hidden");
    }

    function clearRelayPlayersInfo() {
        relayPlayersSnapshot = [];
        if (relayPlayersInfo) {
            relayPlayersInfo.classList.add("is-hidden");
        }
        if (relayPlayersCount) {
            relayPlayersCount.textContent = "0";
        }
        if (relayPlayersList) {
            relayPlayersList.textContent = "";
        }
    }

    function normalizeRelayPlayer(player, fallbackOnline = true) {
        if (!player || typeof player !== "object") {
            return null;
        }
        const playerName = String(player.name || player.playerName || "").trim();
        const playerUuid =
            typeof player.uuid === "string"
                ? player.uuid
                : typeof player.playerUuid === "string"
                ? player.playerUuid
                : "";
        if (!playerName && !playerUuid) {
            return null;
        }
        return {
            name: playerName || "Unknown",
            uuid: playerUuid,
            online: typeof player.online === "boolean" ? player.online : fallbackOnline,
        };
    }

    function isSameRelayPlayer(a, b) {
        if (!a || !b) return false;
        if (a.uuid && b.uuid && a.uuid === b.uuid) {
            return true;
        }
        return a.name !== "" && b.name !== "" && a.name === b.name;
    }

    function setRelayPlayersInfo(players) {
        if (!relayPlayersInfo || !relayPlayersList || !relayPlayersCount) {
            return;
        }
        const safePlayers = Array.isArray(players)
            ? players
                .map((player) => normalizeRelayPlayer(player, true))
                .filter(Boolean)
            : [];
        relayPlayersSnapshot = safePlayers;
        relayPlayersList.textContent = "";
        relayPlayersCount.textContent = String(safePlayers.length);
        if (safePlayers.length === 0) {
            const emptyMessage = document.createElement("p");
            emptyMessage.className = "relay-empty-message";
            emptyMessage.textContent = "No players online.";
            relayPlayersList.appendChild(emptyMessage);
            relayPlayersInfo.classList.remove("is-hidden");
            return;
        }
        for (const player of safePlayers) {
            const playerName = String(player?.name || "Unknown");
            const playerUuid = typeof player?.uuid === "string" ? player.uuid : "";
            const isOnline = typeof player?.online === "boolean" ? player.online : true;
            const row = document.createElement("div");
            row.className = "relay-player-row";
            const main = document.createElement("div");
            main.className = "relay-player-main";
            const nameElement = document.createElement("strong");
            nameElement.className = "relay-player-name";
            nameElement.textContent = playerName;
            nameElement.title = playerName;
            const uuidElement = document.createElement("span");
            uuidElement.className = "relay-player-uuid";
            uuidElement.textContent = playerUuid || "UUID unavailable";
            uuidElement.title = playerUuid || "UUID unavailable";
            const badge = document.createElement("span");
            badge.className = isOnline
                ? "relay-player-badge"
                : "relay-player-badge offline";
            badge.textContent = isOnline ? "online" : "offline";
            main.appendChild(nameElement);
            main.appendChild(uuidElement);
            row.appendChild(main);
            row.appendChild(badge);
            relayPlayersList.appendChild(row);
        }
        relayPlayersInfo.classList.remove("is-hidden");
    }

    function upsertRelayPlayer(player) {
        const normalizedPlayer = normalizeRelayPlayer(player, true);
        if (!normalizedPlayer) {
            return;
        }
        const existingIndex = relayPlayersSnapshot.findIndex((currentPlayer) =>
            isSameRelayPlayer(currentPlayer, normalizedPlayer)
        );
        if (existingIndex >= 0) {
            relayPlayersSnapshot[existingIndex] = {
                ...relayPlayersSnapshot[existingIndex],
                ...normalizedPlayer,
                online: true,
            };
        } else {
            relayPlayersSnapshot.push({
                ...normalizedPlayer,
                online: true,
            });
        }
        setRelayPlayersInfo(relayPlayersSnapshot);
    }

    function markRelayPlayerOffline(player) {
        const normalizedPlayer = normalizeRelayPlayer(player, false);
        if (!normalizedPlayer) {
            return;
        }
        const existingIndex = relayPlayersSnapshot.findIndex((currentPlayer) =>
            isSameRelayPlayer(currentPlayer, normalizedPlayer)
        );
        if (existingIndex >= 0) {
            relayPlayersSnapshot[existingIndex] = {
                ...relayPlayersSnapshot[existingIndex],
                ...normalizedPlayer,
                online: false,
            };
        } else {
            relayPlayersSnapshot.push({
                ...normalizedPlayer,
                online: false,
            });
        }
        setRelayPlayersInfo(relayPlayersSnapshot);
    }

    function buildRelayWebSocketUrl() {
        const relayUrl = relayUrlInput?.value?.trim() || "ws://127.0.0.1:8787/ws";
        const serverId = relayServerIdInput?.value?.trim() || "demo";
        const pairCode = relayPairCodeInput?.value?.trim() || "123456";
        const url = new URL(relayUrl);
        url.searchParams.set("role", "web");
        url.searchParams.set("serverId", serverId);
        url.searchParams.set("pairCode", pairCode);
        return url.toString();
    }

    function connectBedrock3DRelay() {
        if (bedrock3dRelaySocket && bedrock3dRelaySocket.readyState === WebSocket.OPEN) {
            setRelayStatus("already connected");
            return;
        }
        const wsUrl = buildRelayWebSocketUrl();
        clearRelayPayloadInfo();
        clearRelayPlayersInfo();
        bedrock3dRelaySocket = new WebSocket(wsUrl);
        setRelayStatus("connecting...");
        if (relayConnectBtn) relayConnectBtn.disabled = true;
        if (relayDisconnectBtn) relayDisconnectBtn.disabled = false;
        bedrock3dRelaySocket.addEventListener("open", () => {
            setRelayStatus("connected");
        });
        bedrock3dRelaySocket.addEventListener("message", handleBedrock3DRelayMessage);
        bedrock3dRelaySocket.addEventListener("error", () => {
            setRelayStatus("error, check console");
            console.error("[Bedrock3DLab Relay] WebSocket error");
        });
        bedrock3dRelaySocket.addEventListener("close", () => {
            setRelayStatus("disconnected");
            if (relayConnectBtn) relayConnectBtn.disabled = false;
            if (relayDisconnectBtn) relayDisconnectBtn.disabled = true;
            bedrock3dRelaySocket = null;
        });
    }

    function disconnectBedrock3DRelay() {
        if (!bedrock3dRelaySocket) {
            setRelayStatus("already disconnected");
            return;
        }
        bedrock3dRelaySocket.close();
    }

    async function handlePlayerSkinResponseFromRelay(message) {
        const data = message.data || {};
        try {
            if (!data.skinData) {
                throw new Error("player.skin.response tidak punya skinData.");
            }
            setRelayStatus("decoding PMMP skin...");
            const decodedTexture = skinDataBase64ToPngDataUrl(data.skinData);
            const decodedTextureDataUrl = decodedTexture.dataUrl;
            const hasCustomGeometryData =
                typeof data.geometryData === "string" && data.geometryData.trim() !== "";
            const geometryJson = await loadGeometryJsonForSkinResponse(data);
            const geometries = geometryJson["minecraft:geometry"];
            const selectedGeometryIndex = findGeometryIndexForSkinResponse(
                geometries,
                data
            );
            const selectedGeometry = geometries[selectedGeometryIndex];
            const selectedGeometryIdentifier =
                selectedGeometry.description?.identifier ||
                selectedGeometry.description?.geometry_name ||
                "unknown geometry";
            const geometryLabel = hasCustomGeometryData
                ? selectedGeometryIdentifier
                : `${selectedGeometryIdentifier} fallback`;
            modelData = geometryJson;
            textureDataURL = decodedTextureDataUrl;
            loadedJsonFileName = data.geometryName
                ? `${data.geometryName}.json`
                : "pmmp_player.json";
            activeGeometryIndex = null;
            activeGeometryIdentifier = "geometry";
            jsonFileLabel.textContent = data.geometryName || "PMMP Player";
            textureFileLabel.textContent = data.playerName
                ? `${data.playerName} skin`
                : "PMMP Skin";
            if (geometries.length === 1) {
                geometrySelectorGroup.classList.add("hidden");
                geometrySelectorGroup.style.display = "none";
                geometrySelector.innerHTML = "";
            } else {
                populateGeometrySelector(geometries);
                geometrySelectorGroup.classList.remove("hidden");
                geometrySelectorGroup.style.display = "block";
                geometrySelector.value = String(selectedGeometryIndex);
            }
            await loadAndRender(selectedGeometry, textureDataURL, selectedGeometryIndex);
            setRelayPayloadInfo({
                playerName: data.playerName || data.playerUuid || "-",
                skinId: data.skinId || "-",
                textureSize: `${decodedTexture.width}x${decodedTexture.height}`,
                geometryLabel,
            });
            setRelayStatus(
                data.playerName
                    ? `rendered skin: ${data.playerName}`
                    : "rendered PMMP skin"
            );
            console.log("[Bedrock3DLab Relay] Rendered PMMP skin:", {
                playerName: data.playerName,
                playerUuid: data.playerUuid,
                skinId: data.skinId,
                geometryName: data.geometryName,
                selectedGeometryIndex,
            });
        } catch (error) {
            setRelayStatus("failed to render PMMP skin");
            console.error("[Bedrock3DLab Relay] Failed to render PMMP skin:", error);
        }
    }

    async function handleBedrock3DRelayMessage(event) {
        let envelope;
        try {
            envelope = JSON.parse(event.data);
        } catch (error) {
            console.warn("[Bedrock3DLab Relay] Non-JSON message ignored:", event.data);
            return;
        }
        console.log("[Bedrock3DLab Relay] Received:", envelope);
        if (envelope.type === "relay.ready") {
            setRelayStatus("ready");
            return;
        }
        if (envelope.type === "plugin.connected") {
            setRelayStatus("plugin online");
            return;
        }
        if (envelope.type === "plugin.disconnected") {
            setRelayStatus("plugin offline");
            return;
        }
        if (envelope.type !== "from.plugin") {
            return;
        }
        const message = envelope.message;
        if (!message || typeof message !== "object") {
            console.warn("[Bedrock3DLab Relay] Invalid plugin message:", envelope);
            return;
        }
        if (message.type === "player.skin.response") {
            console.log("[Bedrock3DLab Relay] Skin response received:", message.data);
            await handlePlayerSkinResponseFromRelay(message);
            return;
        }
        if (message.type === "server.players.response") {
            console.log("[Bedrock3DLab Relay] Players response received:", message.data);
            const players = Array.isArray(message.data?.players)
                ? message.data.players
                : [];
            setRelayPlayersInfo(players);
            setRelayStatus(
                players.length === 1
                    ? "received 1 online player"
                    : `received ${players.length} online players`
            );
            return;
        }
        if (message.type === "server.event.player_join") {
            console.log("[Bedrock3DLab Relay] Player join event received:", message.data);
            upsertRelayPlayer({
                name: message.data?.playerName || message.data?.name || "",
                uuid: message.data?.playerUuid || message.data?.uuid || "",
                online: true,
            });
            setRelayStatus(
                message.data?.playerName
                    ? `player joined: ${message.data.playerName}`
                    : "player joined"
            );
            return;
        }
        if (message.type === "server.event.player_quit") {
            console.log("[Bedrock3DLab Relay] Player quit event received:", message.data);
            markRelayPlayerOffline({
                name: message.data?.playerName || message.data?.name || "",
                uuid: message.data?.playerUuid || message.data?.uuid || "",
            });
            setRelayStatus(
                message.data?.playerName
                    ? `player quit: ${message.data.playerName}`
                    : "player quit"
            );
            return;
        }
    }
    animate();
}

function undo() {
    if (undoStack.length === 0) return;
    const action = undoStack.pop();
    const object = boneMap.get(action.boneName);
    if (object) {
        const redoAction = {
            boneName: object.name,
            oldState: {
                position: object.position.clone(),
                quaternion: object.quaternion.clone(),
                scale: object.scale.clone(),
            },
        };
        redoStack.push(redoAction);
        object.position.copy(action.oldState.position);
        object.quaternion.copy(action.oldState.quaternion);
        object.scale.copy(action.oldState.scale);
    }
}

function redo() {
    if (redoStack.length === 0) return;
    const action = redoStack.pop();
    const object = boneMap.get(action.boneName);
    if (object) {
        const undoAction = {
            boneName: object.name,
            oldState: {
                position: object.position.clone(),
                quaternion: object.quaternion.clone(),
                scale: object.scale.clone(),
            },
        };
        undoStack.push(undoAction);
        object.position.copy(action.oldState.position);
        object.quaternion.copy(action.oldState.quaternion);
        object.scale.copy(action.oldState.scale);
    }
}

function experimentalRecenterPivot(object) {
    if (object.children.length === 0) return;
    const worldCenter = new THREE.Vector3();
    new THREE.Box3().setFromObject(object).getCenter(worldCenter);
    const localCenter = object.worldToLocal(worldCenter.clone());
    if (localCenter.lengthSq() === 0) return;
    for (const child of object.children) {
        child.position.sub(localCenter);
    }
    const offsetInParentSpace = localCenter.clone().applyQuaternion(object.quaternion);
    object.position.add(offsetInParentSpace);
}

function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) {
        renderer.setSize(width, height, false);
    }
    return needResize;
}

function disposeMaterial(material, disposedTextures = new Set()) {
    if (!material) return;
    // dispose semua texture yg menempel di material, misalnya map, alphaMap, normalMap, dll.
    for (const value of Object.values(material)) {
        if (value && value.isTexture && !disposedTextures.has(value)) {
            value.dispose();
            disposedTextures.add(value);
        }
    }
    material.dispose();
}

function disposeObject3D(object, disposedGeometries = new Set(), disposedMaterials = new Set(), disposedTextures = new Set()) {
    object.traverse((child) => {
        if (child.geometry && !disposedGeometries.has(child.geometry)) {
            child.geometry.dispose();
            disposedGeometries.add(child.geometry);
        }
        if (child.material) {
            if (Array.isArray(child.material)) {
                child.material.forEach((material) => {
                    if (material && !disposedMaterials.has(material)) {
                        disposeMaterial(material, disposedTextures);
                        disposedMaterials.add(material);
                    }
                });
            } else if (!disposedMaterials.has(child.material)) {
                disposeMaterial(child.material, disposedTextures);
                disposedMaterials.add(child.material);
            }
        }
    });
}

function clearModelContainer(parentGroup) {
    disposeObject3D(parentGroup);
    // hapus semua object/bone/mesh lama dari container
    parentGroup.clear();
    // bersihin state editor yg terhubung ke model lama
    boneMap.clear();
    boneList.innerHTML = "";
    undoStack.length = 0;
    redoStack.length = 0;
    actionInProgress = null;
    boneMenuContainer.classList.add("hidden");
    boneMenuToggle.classList.add("hidden");
}

function setCameraToFrontRightTop(camera, controls, center, cameraDist) {
    camera.position.set(
        center.x + cameraDist * 0.6,
        center.y + cameraDist * 0.45,
        center.z - cameraDist * 0.8
    );
    controls.target.copy(center);
    controls.update();
}

async function loadModelAndTexture(parentGroup, geo, textureDataURL, camera, controls) {
    try {
        clearModelContainer(parentGroup);
        const textureLoader = new THREE.TextureLoader();
        const texture = await textureLoader.loadAsync(textureDataURL);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.flipY = false;
        const textureWidth = geo.description.texture_width;
        const textureHeight = geo.description.texture_height;
        const allBones = new Map();

        // const bonesToRender = geo.bones.filter(
        //     (b) =>
        //         // b.name === "root" ||
        //         // b.name === "waist" ||
        //         b.name === "head" || b.name === "lower_beak" //||
        //     //     b.name === "hat" ||
        //     //     b.name === "leftArm" ||
        //     //     b.name === "leftSleeve" ||
        //     //     b.name === "rightArm" ||
        //     //     b.name === "rightSleeve" ||
        //     //     b.name === "jacket"
        // );

        const bonesToRender = geo.bones;
        const createdBoneGroups = [];

        for (const boneData of bonesToRender) {
            // if (boneData.pivot) {
            //     boneData.pivot[0] *= -1;
            //     boneData.pivot[2] *= -1;
            // }
            const boneGroup = new THREE.Group();
            boneGroup.name = boneData.name;
            boneMap.set(boneData.name, boneGroup);
            allBones.set(boneData.name, boneGroup);
            createdBoneGroups.push(boneGroup);

            const pivot = [...(boneData.pivot || [0, 0, 0])];
            const rotation = [...(boneData.rotation || [0, 0, 0])];
            pivot[0] = -pivot[0];
            boneGroup.position.set(pivot[0], pivot[1], pivot[2]);
            boneGroup.rotation.order = "ZYX";
            boneGroup.rotation.set(
                THREE.MathUtils.degToRad(-rotation[0]),
                THREE.MathUtils.degToRad(-rotation[1]),
                THREE.MathUtils.degToRad(rotation[2])
            );

            if (boneData.cubes) {
                for (const cubeData of boneData.cubes) {
                    const inflate = cubeData.inflate || 0;
                    const size = [...cubeData.size];
                    const origin = [...(cubeData.origin || [0, 0, 0])];
                    if (size[0] === 0) size[0] = 0.01;
                    if (size[1] === 0) size[1] = 0.01;
                    if (size[2] === 0) size[2] = 0.01;
                    origin[0] = -(origin[0] + size[0]);
                    // origin[2] = -(origin[2] + size[2]);
                    const finalOrigin = [origin[0] - inflate, origin[1] - inflate, origin[2] - inflate];
                    const geometry = new THREE.BoxGeometry(
                        size[0] + inflate * 2,
                        size[1] + inflate * 2,
                        size[2] + inflate * 2
                    );

                    applyUvToCube(geometry, cubeData, textureWidth, textureHeight);
                    const isOuterLayer = inflate > 0;
                    let material;

                    if (isOuterLayer) {
                        material = new THREE.MeshLambertMaterial({
                            map: texture,
                            transparent: true,
                            side: THREE.DoubleSide,
                            depthWrite: false,
                            alphaTest: 0.5,
                        });
                    } else {
                        material = new THREE.MeshLambertMaterial({
                            map: texture,
                            transparent: true,
                            side: THREE.DoubleSide,
                            alphaTest: 0.5,
                        });
                    }
                    const mesh = new THREE.Mesh(geometry, material);
                    if (isOuterLayer) {
                        mesh.renderOrder = 1;
                    } else {
                        mesh.renderOrder = 0;
                    }

                    if (cubeData.pivot && cubeData.rotation && !cubeData.rotation.every(r => r === 0)) {
                        // percube rotation, pake subgroup buat rotate di pivot cube
                        const cubePivot = [...cubeData.pivot];
                        cubePivot[0] = -cubePivot[0]; // flip X untuk pivot juga
                        const cubeGroup = new THREE.Group();
                        cubeGroup.position.set(
                            cubePivot[0] - pivot[0],
                            cubePivot[1] - pivot[1],
                            cubePivot[2] - pivot[2]
                        );
                        cubeGroup.rotation.order = "ZYX";
                        const cubeRot = [...cubeData.rotation];
                        // Bedrock -> Three.js rotation: flip X dan Y (bukan Z)
                        cubeGroup.rotation.set(
                            THREE.MathUtils.degToRad(-cubeRot[0]),
                            THREE.MathUtils.degToRad(-cubeRot[1]),
                            THREE.MathUtils.degToRad(cubeRot[2])
                        );
                        mesh.position.set(
                            finalOrigin[0] - cubePivot[0] + (size[0] + inflate * 2) / 2,
                            finalOrigin[1] - cubePivot[1] + (size[1] + inflate * 2) / 2,
                            finalOrigin[2] - cubePivot[2] + (size[2] + inflate * 2) / 2
                        );
                        cubeGroup.add(mesh);
                        boneGroup.add(cubeGroup);
                    } else {
                        // gak ada percube rotation, langsung offset ke bone
                        mesh.position.set(
                            finalOrigin[0] - pivot[0] + (size[0] + inflate * 2) / 2,
                            finalOrigin[1] - pivot[1] + (size[1] + inflate * 2) / 2,
                            finalOrigin[2] - pivot[2] + (size[2] + inflate * 2) / 2
                        );
                        boneGroup.add(mesh);
                    }
                }
            }
        }

        for (const boneData of bonesToRender) {
            const bone = allBones.get(boneData.name);
            if (boneData.parent && allBones.has(boneData.parent)) {
                const parentBone = allBones.get(boneData.parent);
                const parentData = bonesToRender.find((b) => b.name === boneData.parent);
                if (parentData) {
                    let parentPivot = parentData.pivot || [0, 0, 0];
                    let childPivot = boneData.pivot || [0, 0, 0];
                    //parentPivot[0] *= -1;
                    bone.position.set(
                        parentPivot[0] - childPivot[0],
                        childPivot[1] - parentPivot[1],
                        childPivot[2] - parentPivot[2]
                    );
                    parentBone.add(bone);
                }
            } else {
                parentGroup.add(bone);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        const box = new THREE.Box3().setFromObject(parentGroup);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const fov = camera.fov * (Math.PI / 180);
        const diagonal = size.length();
        let cameraDist = diagonal / 2 / Math.tan(fov / 2);
        cameraDist *= 1.2;
        setCameraToFrontRightTop(camera, controls, center, cameraDist);
        return createdBoneGroups;
    } catch (error) {
        console.error("Gagal memuat model:", error);
        alert("Terjadi error saat memuat model. Cek console (F12) untuk detail.");
    }
}

function applyUvToCube(geometry, cubeData, texWidth, texHeight) {
    const { uv, size, mirror = false } = cubeData;
    const [w, h, d] = size;
    const uvAttr = geometry.attributes.uv;

    if (cubeData.uv instanceof Array) { 
        // urutan Three.js: right, left, top, bottom, front, back
        let faces = [
            [uv[0], uv[1] + d, d, h], // right (+X)
            [uv[0] + d + w, uv[1] + d, d, h], // left  (-X)
            [uv[0] + d, uv[1], w, d], // top   (+Y)
            [uv[0] + d + w, uv[1], w, d], // bottom(-Y)
            [uv[0] + d + w + d, uv[1] + d, w, h], // back  (-Z)
            [uv[0] + d, uv[1] + d, w, h], // front (+Z)  
        ];

        if (mirror) {
            [faces[0], faces[1]] = [faces[1], faces[0]];
        }
        const uvInsetX = 0.1 / texWidth;
        const uvInsetY = 0.1 / texHeight;

        for (let i = 0; i < 6; i++) {
            const [u, v, fw, fh] = faces[i];
            let u0 = u / texWidth + uvInsetX;
            let v0 = v / texHeight + uvInsetY;
            let u1 = (u + fw) / texWidth - uvInsetX;
            let v1 = (v + fh) / texHeight - uvInsetY;
            if (i !== 2 && i !== 3) {
                [u0, u1] = [u1, u0];
            }
            if (i === 2 || i === 3) {
                [v0, v1] = [v1, v0];
            }
            if (i === 3) {
                uvAttr.setXY(i * 4 + 0, u0, v1);
                uvAttr.setXY(i * 4 + 1, u1, v1);
                uvAttr.setXY(i * 4 + 2, u0, v0);
                uvAttr.setXY(i * 4 + 3, u1, v0);
            } else {
                uvAttr.setXY(i * 4 + 0, u1, v0);
                uvAttr.setXY(i * 4 + 1, u0, v0);
                uvAttr.setXY(i * 4 + 2, u1, v1);
                uvAttr.setXY(i * 4 + 3, u0, v1);
            }
        }
    } else if (cubeData.uv && typeof cubeData.uv === 'object') {
        // perface uv
        // Three.js BoxGeometry face order, +X, -X, +Y, -Y, +Z, -Z
        const faceOrder = ['east', 'west', 'up', 'down', 'south', 'north'];
        for (let i = 0; i < 6; i++) {
            const faceName = faceOrder[i];
            const faceUV = cubeData.uv[faceName];
            if (faceUV && faceUV.uv && faceUV.uv_size) {
                let fu = faceUV.uv[0];
                let fv = faceUV.uv[1];
                let fuw = faceUV.uv_size[0];
                let fvh = faceUV.uv_size[1];
                // normalize to 0-1 range
                let u0 = fu / texWidth;
                let v0 = fv / texHeight;
                let u1 = (fu + fuw) / texWidth;
                let v1 = (fv + fvh) / texHeight;
                if (i !== 2 && i !== 3) {
                    [u0, u1] = [u1, u0];
                }
                if (i === 2 || i === 3) {
                    [v0, v1] = [v1, v0];
                }
                uvAttr.setXY(i * 4 + 0, u1, v0);
                uvAttr.setXY(i * 4 + 1, u0, v0);
                uvAttr.setXY(i * 4 + 2, u1, v1);
                uvAttr.setXY(i * 4 + 3, u0, v1);
            } else {
                // no UV for this face, set to 0
                uvAttr.setXY(i * 4 + 0, 0, 0);
                uvAttr.setXY(i * 4 + 1, 0, 0);
                uvAttr.setXY(i * 4 + 2, 0, 0);
                uvAttr.setXY(i * 4 + 3, 0, 0);
            }
        }
    }
    uvAttr.needsUpdate = true;
}

function createCustomGizmo() {
    const gizmoGroup = new THREE.Group();
    // X=merah, Y=hijau, Z=biru
    const colors = { x: 0xff3333, y: 0x33ff33, z: 0x3333ff };
    const axisLength = 1.2;
    const ballRadius = 0.3;
    const cylinderRadius = 0.05;
    function createLabel(text) {
        const canvas = document.createElement('canvas');
        const size = 64; // resolusi kanvas teks
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.font = 'bold 48px Arial, sans-serif'; 
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = 'black'; // warna tulisan, hitam biar kontras
        context.fillText(text, size / 2, size / 2);
        const texture = new THREE.CanvasTexture(canvas);
        // pake SpriteMaterial biar teks selalu ngehadep kamera
        const material = new THREE.SpriteMaterial({ 
            map: texture,
            depthTest: false // biar teksnya selalu nongol paling depan, gak ketutup bola
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.4, 0.4, 0.4); // ukuran teks
        return sprite;
    }
    // bikin satu lengan sumbu (batang + bola)
    function createAxis(color, rotation, labelText) {
        const axis = new THREE.Group();
        // batang (cylinder)
        const material = new THREE.MeshBasicMaterial({ color: color });
        const cylinderGeo = new THREE.CylinderGeometry(cylinderRadius, cylinderRadius, axisLength, 8);
        cylinderGeo.translate(0, axisLength / 2, 0); // geser biar titik pusat di ujung bawah
        const cylinder = new THREE.Mesh(cylinderGeo, material);
        // bola (sphere) di ujung
        const sphereGeo = new THREE.SphereGeometry(ballRadius, 16, 16);
        sphereGeo.translate(0, axisLength, 0); // geser bola ke ujung batang
        const sphere = new THREE.Mesh(sphereGeo, material);
        const label = createLabel(labelText);
        label.position.y = axisLength; // posisi di tengah bola
        label.renderOrder = 1;
        axis.add(cylinder);
        axis.add(sphere);
        axis.add(label);
        if (rotation) axis.rotation.set(...rotation);
        return axis;
    }
    // 3 sumbu
    const xAxis = createAxis(colors.x, [0, 0, -Math.PI / 2], "X"); // putar ke sumbu X
    const yAxis = createAxis(colors.y, [0, 0, 0], "Y"); // sumbu Y udah tegak lurus
    const zAxis = createAxis(colors.z, [Math.PI / 2, 0, 0], "Z");  // pputar ke sumbu Z
    gizmoGroup.add(xAxis);
    gizmoGroup.add(yAxis);
    gizmoGroup.add(zAxis);
    // bola abu abu kecil di tengah pusat
    const centerBall = new THREE.Mesh(
        new THREE.SphereGeometry(ballRadius * 0.6, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xaaaaaa })
    );
    gizmoGroup.add(centerBall);
    return gizmoGroup;
}

main();
