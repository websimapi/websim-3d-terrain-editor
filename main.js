import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TerrainDatabase } from './terraindb.js';
import { PlayerManager } from './players.js';
import { ColorManager } from './colorManager.js';

// Room setup for multiplayer
const room = new WebsimSocket();
let terrainHeightModifiedInStroke = false; // Tracks if height changed in current stroke
let terrainColorModifiedInStroke = false; // Tracks if color changed in this stroke
let myUsername = '';

// Will be initialized later
let terrainDB;
let playerManager;
let colorManager;

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // Sky blue background

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 60, 60); // Adjusted initial camera position

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; // Enable shadows
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows
document.body.appendChild(renderer.domElement);

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7); // Slightly brighter ambient
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2); // Slightly stronger directional
directionalLight.position.set(70, 120, 40); // Adjusted light position
directionalLight.castShadow = true;
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 1;
directionalLight.shadow.camera.far = 300; // Adjusted far plane
directionalLight.shadow.camera.left = -100;
directionalLight.shadow.camera.right = 100;
directionalLight.shadow.camera.top = 100;
directionalLight.shadow.camera.bottom = -100;
directionalLight.shadow.bias = -0.001; // Helps prevent shadow acne
scene.add(directionalLight);

// --- Terrain ---
const terrainSize = 100;
const terrainSegments = 128; // Increased detail
const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
geometry.rotateX(-Math.PI / 2); // Rotate to be horizontal

// Vertices and colors will be set during initialization by TerrainDatabase/ColorManager
// geometry.computeVertexNormals(); // Computation moved after data loading

let currentTool = 'raise'; // 'select', 'raise', 'lower', 'flatten', 'color'
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    // Start with a neutral color/style, will be updated
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true, depthTest: false, depthWrite: false })
);
brushIndicator.renderOrder = 1; // Render brush indicator on top
brushIndicator.visible = false;
scene.add(brushIndicator);

// Material setup - vertexColors will be enabled by ColorManager if needed
const material = new THREE.MeshStandardMaterial({
    // color: 0xffffff, // Base color ignored when vertexColors is true
    side: THREE.DoubleSide,
    metalness: 0.0,
    roughness: 0.9,
    vertexColors: false // Initialize as false, ColorManager enables it
});

const terrain = new THREE.Mesh(geometry, material);
terrain.receiveShadow = true;
terrain.castShadow = true;
terrain.name = 'terrain'; // Name for easy reference
scene.add(terrain);

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // Smooth camera movement
controls.dampingFactor = 0.05;
controls.screenSpacePanning = true;
controls.minDistance = 5;
controls.maxDistance = 150;
controls.maxPolarAngle = Math.PI / 2.1;
controls.target.set(0, 0, 0);
controls.zoomSpeed = 0.5;
controls.enableZoom = true;

// --- Terrain Editing ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;
const brushSizeSlider = document.getElementById('brushSize');
const brushStrengthSlider = document.getElementById('brushStrength');
const flattenHeightSlider = document.getElementById('flattenHeight');
const brushSizeValueSpan = document.getElementById('brushSizeValue');
const brushStrengthValueSpan = document.getElementById('brushStrengthValue');
const flattenHeightValueSpan = document.getElementById('flattenHeightValue');
const flattenHeightControl = document.getElementById('flattenHeightControl');
const toolButtons = document.querySelectorAll('.button-group button'); // Selects all buttons in the group, including Paint

// --- UI Update Functions ---
function updateSliderValue(slider, span) {
    span.textContent = parseFloat(slider.value).toFixed(1);
}

function updateActiveButton() {
    const allToolButtons = document.querySelectorAll('#controls .button-group button'); // Ensure selection includes dynamic buttons if any pattern changes
    allToolButtons.forEach(btn => {
        if (btn.dataset.tool === currentTool) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    flattenHeightControl.style.display = currentTool === 'flatten' ? 'flex' : 'none';
    // Update brush indicator immediately when tool changes
    // Call moved to pointer move and down handlers to ensure raycasting is current
    // updateBrushIndicator(); // Don't call here, call on interaction
    // Hide brush if select tool is chosen
    if (currentTool === 'select') {
        brushIndicator.visible = false;
    }
}

// --- Event Listeners ---
brushSizeSlider.addEventListener('input', () => {
    updateSliderValue(brushSizeSlider, brushSizeValueSpan);
    updateBrushIndicator(); // Update size visually
});
brushStrengthSlider.addEventListener('input', () => {
    updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
     // Strength doesn't visually change indicator, no update needed here
});
flattenHeightSlider.addEventListener('input', () => {
    updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);
    // Flatten height doesn't visually change indicator, no update needed here
});


// Add listener for all tool buttons
toolButtons.forEach(button => {
    button.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent event bubbling
        currentTool = button.dataset.tool;
        updateActiveButton();
        // Update brush indicator state when tool changes
        updateBrushIndicator();
    });
});

renderer.domElement.addEventListener('pointermove', onPointerMoveTerrainCheck, false);
renderer.domElement.addEventListener('pointerdown', onPointerDownTerrain, false);
window.addEventListener('pointerup', onPointerUpTerrain, false); // Catch release outside canvas
window.addEventListener('resize', onWindowResize, false);
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Event Handlers ---
function onPointerMoveTerrainCheck(event) {
    const isPointerOverUI = isPointerOverElement(event, [
        document.getElementById('controls'),
        document.getElementById('players-list')
    ]);

    // Update mouse coordinates regardless of UI overlap for potential future use
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Handle brush indicator update only if not over UI
    if (!isPointerOverUI) {
        updateBrushIndicator(); // Update indicator position/visibility/style
    } else {
        brushIndicator.visible = false; // Ensure hidden if over UI
    }

    // Apply brush only if mouse is down, tool is active, and not over UI
    if (isMouseDown && currentTool !== 'select' && !isPointerOverUI) {
        applyBrush();
    }
}

function onPointerDownTerrain(event) {
     const isPointerOverUI = isPointerOverElement(event, [
        document.getElementById('controls'),
        document.getElementById('players-list')
    ]);

    if (isPointerOverUI || event.button !== 0 || event.target !== renderer.domElement) {
         // Ignore clicks on UI, non-left clicks, or clicks not directly on the canvas
        return;
    }

    isMouseDown = true;

    // Reset modification flags for the new stroke
    terrainHeightModifiedInStroke = false;
    terrainColorModifiedInStroke = false;

    if (currentTool !== 'select') {
        controls.enabled = false; // Disable camera pan/rotate while editing
        updateBrushIndicator(); // Ensure indicator is visible and positioned correctly
        applyBrush(); // Apply brush on the first click immediately
    } else {
         controls.enabled = true; // Ensure camera is enabled in select mode
         brushIndicator.visible = false; // Hide brush in select mode
    }
}

async function onPointerUpTerrain(event) { // Make async to await saves
    if (event.button === 0 && isMouseDown) {
        isMouseDown = false;
        controls.enabled = true; // Re-enable camera controls

        // Wrap saves in a try/catch block
        try {
            let savePromises = [];
            // Save terrain height changes if any occurred during the stroke
            if (terrainHeightModifiedInStroke && terrainDB) {
                console.log("Stroke ended, queueing height state save...");
                savePromises.push(terrainDB.saveTerrainChanges()); // Add promise to array
            }

            // Save terrain color changes if any occurred during the stroke
            if (terrainColorModifiedInStroke && colorManager) {
                console.log("Stroke ended, queueing color state save...");
                 savePromises.push(colorManager.saveColorChanges()); // Add promise to array
            }

            // Await all pending save operations
            if (savePromises.length > 0) {
                 await Promise.all(savePromises);
                 console.log("All pending saves completed.");
            }

        } catch (error) {
             console.error("Error during save operations after pointer up:", error);
             // Show a generic error using one of the managers' status methods
             if (terrainDB) terrainDB.showSaveStatus(true, 'Error saving changes!', true);
             else if (colorManager) colorManager.showSaveStatus(true, 'Error saving changes!', true);
             // Hide error after a delay
             setTimeout(() => {
                 if (terrainDB) terrainDB.hideSaveStatus();
                 if (colorManager) colorManager.hideSaveStatus();
             }, 3000);
        } finally {
            // Reset flags regardless of save success/failure
            terrainHeightModifiedInStroke = false;
            terrainColorModifiedInStroke = false;
        }
    }
}

// Helper function to check if pointer event is over specific elements
function isPointerOverElement(event, elements) {
    const pointerX = event.clientX;
    const pointerY = event.clientY;
    for (const element of elements) {
        if (element) {
            const rect = element.getBoundingClientRect();
            if (pointerX >= rect.left && pointerX <= rect.right &&
                pointerY >= rect.top && pointerY <= rect.bottom) {
                return true; // Pointer is inside this element's bounds
            }
        }
    }
    return false; // Pointer is not inside any of the specified elements
}


function applyBrush() {
    if (currentTool === 'select' || !terrainDB || !colorManager) return; // Don't apply if selecting or managers not ready

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;

        const brushRadius = parseFloat(brushSizeSlider.value);
        const brushStrength = parseFloat(brushStrengthSlider.value);
        const targetFlattenHeight = parseFloat(flattenHeightSlider.value);

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();
        let vertexModified = false; // Tracks if any vertex was changed in *this specific call*

        // --- Color Application ---
        if (currentTool === 'color') {
            const appliedColor = colorManager.applyColorBrush(hitPoint, brushRadius, brushStrength);
            if (appliedColor) {
                terrainColorModifiedInStroke = true; // Mark that color was changed in this stroke
                vertexModified = true; // Indicate geometry update needed (handled by colorManager)
            }
            // Normals don't change with color. Don't apply height changes.
            return; // Stop here if painting
        }

        // --- Height Application (Raise, Lower, Flatten) ---
        let heightChanged = false;
        const tempVertex = new THREE.Vector3(); // For performance
         // Store indices that were actually changed in this step
        const changedIndices = [];

        for (let i = 0; i < positions.count; i++) {
            tempVertex.fromBufferAttribute(positions, i);
            // Use XZ plane distance for brush effect
            const dx = tempVertex.x - hitPoint.x;
            const dz = tempVertex.z - hitPoint.z;
            const distanceSq = dx * dx + dz * dz;
            const brushRadiusSq = brushRadius * brushRadius;

            if (distanceSq < brushRadiusSq) {
                const distance = Math.sqrt(distanceSq);
                 // Cosine falloff: 1 at center, 0 at edge
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                // Adjust strength application, maybe make less aggressive
                const strengthFactor = brushStrength * falloff * 0.1; // Smaller base factor
                const currentHeight = tempVertex.y; // Use y from tempVertex
                let newHeight = currentHeight;

                if (currentTool === 'raise') {
                    newHeight = currentHeight + strengthFactor;
                } else if (currentTool === 'lower') {
                    newHeight = currentHeight - strengthFactor;
                } else if (currentTool === 'flatten') {
                    // Lerp towards target height based on strength/falloff
                    // Make flatten less aggressive maybe
                    newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, strengthFactor * 0.5);
                }

                // Only update if the height actually changed significantly to avoid floating point noise
                if (Math.abs(newHeight - currentHeight) > 0.001) {
                     positions.setY(i, newHeight);
                     // Accumulate change in TerrainDatabase for saving later *after* the stroke
                     terrainDB.accumulateHeightChange(i, newHeight);
                     heightChanged = true; // Mark that height was modified in this applyBrush call
                     vertexModified = true;
                     changedIndices.push(i); // Record index that changed
                }
            }
        }

        // If height vertices were modified in this call, update geometry and set stroke flag
        if (heightChanged) {
            positions.needsUpdate = true;
             // Optimization: Only compute normals if height actually changed significantly.
             // For performance, maybe only compute normals for affected vertices later if possible,
             // but full computeVertexNormals is usually required for correct lighting.
            geometry.computeVertexNormals();
            terrainHeightModifiedInStroke = true; // Mark that height was changed in this stroke
        }
    }
}


function updateBrushIndicator() {
    // Raycast only if a tool other than select is active
    if (currentTool === 'select') {
        brushIndicator.visible = false;
        return;
    }

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        // Add small offset to prevent z-fighting with terrain
        brushIndicator.position.y += 0.1;

        // Make indicator size relative to brush setting
        const scale = parseFloat(brushSizeSlider.value); // Direct scaling might be better
        brushIndicator.scale.set(scale, scale, scale);
        brushIndicator.visible = true; // Make visible since we have an intersection

        // Update color/style based on tool
        if (currentTool === 'color' && colorManager) {
            try {
                brushIndicator.material.color.set(colorManager.currentColor);
                brushIndicator.material.wireframe = false;
                brushIndicator.material.opacity = 0.6;
            } catch (e) {
                 console.warn("Invalid color for brush indicator:", colorManager.currentColor);
                 brushIndicator.material.color.set(0xffffff); // Fallback
                 brushIndicator.material.wireframe = true;
                 brushIndicator.material.opacity = 0.5;
            }
        } else {
            // Default indicator style for height tools
            brushIndicator.material.color.set(0xffffff);
            brushIndicator.material.wireframe = true;
            brushIndicator.material.opacity = 0.5;
        }
    } else {
        brushIndicator.visible = false; // Hide if not intersecting terrain
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Listen for color changes from ColorManager UI
document.addEventListener('colorChanged', (event) => {
    // Switch to color tool automatically when a color is picked
    currentTool = 'color';
    updateActiveButton(); // Update UI to show color tool active
    updateBrushIndicator(); // Update brush appearance immediately
});

// Initialize Database, Color, Players
async function initializeMultiplayer() {
    try {
        console.log("Initializing multiplayer...");
        await room.initialize();
        myUsername = room.peers[room.clientId].username;
        console.log(`Connected as: ${myUsername}`);

        // Create managers
        colorManager = new ColorManager(room, geometry, scene);
        terrainDB = new TerrainDatabase(room, geometry, scene);
        playerManager = new PlayerManager(room, scene);

        // Initialize UI components first
        colorManager.initializeColorPalette(); // Setup UI swatches

        // Load data sequentially to ensure dependencies (like color attribute) are handled
        console.log("Loading color data...");
        await colorManager.loadColorData(); // Load canonical state, apply to geometry, ensures color attr exists
        console.log("Loading terrain data...");
        await terrainDB.loadTerrainData(); // Load canonical state, apply to geometry

        // Ensure material reflects vertex color state after loading
         if (geometry.attributes.color && material) {
            material.vertexColors = true;
            material.needsUpdate = true;
        }


        // Initialize Player Manager AFTER terrain/color data is loaded
        playerManager.initialize(); // Also sets up presence subscription internally

        // Start periodic player position updates
        setInterval(() => {
            if (playerManager && room.initialized) { // Check if room is still initialized
                playerManager.updatePlayerPosition(camera, controls);
            }
        }, 200); // Send updates 5 times/sec

        console.log("Multiplayer initialization complete.");

        // Final geometry update and normal computation after all loading and initial application
        geometry.attributes.position.needsUpdate = true;
        if (geometry.attributes.color) {
            geometry.attributes.color.needsUpdate = true;
        }
        geometry.computeVertexNormals(); // Compute normals once after all initial state is applied


    } catch (error) {
        console.error('Error initializing multiplayer:', error);
         // Display a user-friendly error message
         const errorDiv = document.createElement('div');
         errorDiv.style.position = 'absolute';
         errorDiv.style.top = '50%';
         errorDiv.style.left = '50%';
         errorDiv.style.transform = 'translate(-50%, -50%)';
         errorDiv.style.backgroundColor = 'rgba(200, 0, 0, 0.8)';
         errorDiv.style.color = 'white';
         errorDiv.style.padding = '20px';
         errorDiv.style.borderRadius = '8px';
         errorDiv.style.zIndex = '100';
         errorDiv.textContent = `Error initializing terrain editor: ${error.message}. Please try refreshing.`;
         document.body.appendChild(errorDiv);
    }
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);

    // Update controls only if enabled (not during brush stroke)
    if (controls.enabled) {
        controls.update(); // Required for damping
    }


    // Render player markers if player manager is initialized
    if (playerManager) {
        playerManager.renderPlayerPositions();
    }

     // Update brush indicator position smoothly in the animation loop IF it's visible
     // This prevents jerky movement compared to only updating on pointermove
     // Re-evaluate if needed - updateBrushIndicator() already called frequently.
     // if (brushIndicator.visible) {
     //    updateBrushIndicator(); // Can cause excessive raycasting, maybe remove
     // }


    renderer.render(scene, camera);
}

// --- Initial Setup Calls ---
updateSliderValue(brushSizeSlider, brushSizeValueSpan);
updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);
updateActiveButton(); // Set initial active button state and UI visibility

initializeMultiplayer(); // Initialize multiplayer and load data
animate(); // Start the animation loop