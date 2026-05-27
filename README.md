# Minecraft Bedrock 3D Model Renderer

An interactive web-based tool built to load, display, inspect, and edit Minecraft Bedrock Edition geometry 3D models directly in your browser. This project was developed from scratch using Three.js and tackles several rendering challenges to faithfully reproduce models as they appear in Blockbench.

The renderer supports Bedrock geometry JSON files, PNG textures, bone hierarchy inspection, transform tools, clean screenshots, and edited JSON export.

🌐 **[Live Demo](https://ZulfahmiFjr.github.io/3DModelRenderer/)**

Here’s an example of a Sniffer and Player model rendered inside the viewer.

![picture 0](https://raw.githubusercontent.com/ZulfahmiFajri/ProgDas/main/caches/31f85b3217c70ff468486f104fe668d004d268e4e98af5f3d1b8dd4dde41696e.png)

![picture 1](https://raw.githubusercontent.com/ZulfahmiFajri/ProgDas/main/caches/ce38bb3d03206b15af9a5194fd7ad057f869bbe42fed99780fb66b0acbbe49c2.png)

---

## ✨ Key Features

-   **Dynamic Model Loading**  
    Upload your own `model.json` and matching `texture.png` files directly through the interface.

-   **Multi-Geometry Support**  
    Supports JSON files containing multiple entries inside `minecraft:geometry`. When a file contains more than one geometry, the viewer displays a dropdown selector so you can choose which model to render.

-   **Accurate Bedrock Geometry Rendering**  
    Translates Bedrock’s coordinate system, pivots, cube origins, UV mapping, and rotation order into Three.js so models can appear close to how they look in Blockbench.

-   **Bone Hierarchy Panel**  
    Displays the model’s bone structure in a dedicated bone panel. Bones are shown in parent-child hierarchy, making it easier to inspect and select parts of the model.

-   **Interactive Bone Selection**  
    Click a model part or select a bone from the hierarchy panel to highlight and edit that bone.

-   **Transform Editing Tools**  
    Selected bones can be transformed using Three.js TransformControls.

    Shortcuts:

    -   `W` = Translate / Move
    -   `E` = Rotate
    -   `R` = Scale
    -   `Q` = Toggle Local / World transform space
    -   `Esc` = Deselect bone
    -   `Ctrl + Z` = Undo
    -   `Ctrl + Y` = Redo

-   **Undo / Redo Support**  
    Bone transform edits can be undone and redone while editing.

-   **Export Edited JSON**  
    Export the edited model back into a downloadable JSON file. The export system preserves the original file structure while applying supported bone edits.

    Current export support:

    -   Bone pivot updates
    -   Bone rotation updates
    -   Cube origin adjustment when bone pivot changes
    -   Cube pivot adjustment for rotated cubes
    -   Locator position adjustment when available

-   **Advanced Transparency Handling**  
    Implements `alphaTest`, transparent materials, and render ordering to properly display transparent sections, inflated outer layers, and semi-transparent textures while reducing Z-fighting issues.

-   **Support for Complex Geometry**  
    Correctly renders zero-dimension cubes, for example `size: [x, 0, z]`, as very thin planes so they remain visible in Three.js.

-   **Smart Model-Only Screenshot Tool**  
    Capture clean screenshots with one click.

    Screenshot behavior:

    -   Keeps the current camera angle.
    -   Hides grid helpers.
    -   Hides transform gizmo.
    -   Hides selection box.
    -   Hides axis helper.
    -   Uses transparent background.
    -   Auto-crops to frame only the visible model.

-   **Interactive 3D Environment**

    -   Full camera control via OrbitControls.
    -   Rotate, pan, and zoom around the model.
    -   Ground grid with 1:1 scale for size reference.
    -   Custom axis gizmo for orientation.
    -   Ambient and directional lighting for better model depth.

-   **Smart Default Camera Position**  
    After loading a model, the camera automatically frames the model from a front-right-top angle without changing the model geometry.

-   **Memory Cleanup When Reloading Models**  
    Disposes old geometries, materials, and textures when loading another model to reduce memory buildup during repeated testing.

-   **Modern, Responsive UI**  
    A clean and collapsible control panel keeps the workspace neat and maximizes the viewing area.

---

## 🚀 Tech Stack

-   **Three.js**  
    Handles all 3D rendering through WebGL.

-   **HTML5 & CSS3**  
    Provides the layout, styling, responsive interface, control panel, bone panel, and buttons.

-   **JavaScript ES6 Modules**  
    Powers model loading, texture loading, geometry conversion, bone hierarchy building, transform editing, screenshots, and JSON export.

-   **GitHub Pages**  
    Hosts the live static web version of the renderer.

---

## 🛠️ How to Use

1. Open the **[Live Demo](https://ZulfahmiFjr.github.io/3DModelRenderer/)**.

2. In the top-left control panel, choose your files:

    -   **Model Geometry**: select your `model.json`.
    -   **Model Texture**: select the matching `texture.png`.

3. Click **Load Model**.

4. If the JSON file contains multiple geometries, choose one model from the dropdown selector.

5. Your model will be displayed in the viewer.

6. Use your mouse to explore:

    -   **Left Click + Drag**: rotate / orbit the camera.
    -   **Right Click + Drag**: pan the view.
    -   **Scroll Wheel**: zoom in and out.

7. Use the bone panel to inspect and select bones.

8. Use transform shortcuts while a bone is selected:

    -   `W` for move.
    -   `E` for rotate.
    -   `R` for scale.
    -   `Q` to switch local/world space.
    -   `Esc` to deselect.
    -   `Ctrl + Z` to undo.
    -   `Ctrl + Y` to redo.

9. To export your edited model, click **Export Edited JSON**.

10. To save an image of your model, click **Take Screenshot**. This generates a clean PNG containing only the model with a transparent background.

---