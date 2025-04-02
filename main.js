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

let currentTool = 'raise'; // 'select', 'raise', 'lower', 'flatten', 'color'
const brushIndicator = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.5, transparent: true })
);
brushIndicator.visible = false;
scene.add(brushIndicator);

// Material setup - vertexColors will be enabled by ColorManager if needed
const material = new THREE.MeshStandardMaterial({
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
    updateBrushIndicator();
}

// --- Event Listeners ---
brushSizeSlider.addEventListener('input', () => updateSliderValue(brushSizeSlider, brushSizeValueSpan));
brushStrengthSlider.addEventListener('input', () => updateSliderValue(brushStrengthSlider, brushStrengthValueSpan));
flattenHeightSlider.addEventListener('input', () => updateSliderValue(flattenHeightSlider, flattenHeightValueSpan));

toolButtons.forEach(button => {
    button.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent event bubbling
        currentTool = button.dataset.tool;
        updateActiveButton();
    });
});

renderer.domElement.addEventListener('pointermove', onPointerMoveTerrainCheck, false);
renderer.domElement.addEventListener('pointerdown', onPointerDownTerrain, false);
window.addEventListener('pointerup', onPointerUpTerrain, false); // Catch release outside canvas
window.addEventListener('resize', onWindowResize, false);
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Event Handlers ---
function onPointerMoveTerrainCheck(event) {
    const controlsPanel = document.getElementById('controls');
    const playersPanel = document.getElementById('players-list');
    if ( (controlsPanel && controlsPanel.contains(event.target)) ||
         (playersPanel && playersPanel.contains(event.target)) ) {
        brushIndicator.visible = false;
        return;
    }

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    updateBrushIndicator();

    if (isMouseDown && currentTool !== 'select') {
        applyBrush();
    }
}

function onPointerDownTerrain(event) {
    const controlsPanel = document.getElementById('controls');
    const playersPanel = document.getElementById('players-list');
    if ( (controlsPanel && controlsPanel.contains(event.target)) ||
         (playersPanel && playersPanel.contains(event.target)) ||
         event.target !== renderer.domElement ) {
        return;
    }
    if (event.button !== 0) return;

    isMouseDown = true;

    terrainHeightModifiedInStroke = false;
    terrainColorModifiedInStroke = false;

    if (currentTool !== 'select') {
        controls.enabled = false;
        updateBrushIndicator();
        applyBrush();
    } else {
        controls.enabled = true;
    }
}

async function onPointerUpTerrain(event) {
    if (event.button === 0 && isMouseDown) {
        isMouseDown = false;
        controls.enabled = true;

        if (terrainHeightModifiedInStroke && terrainDB) {
            console.log("Stroke ended, saving height state...");
            try {
                await terrainDB.saveTerrainChanges();
                terrainHeightModifiedInStroke = false;
            } catch (error) {
                console.error("Failed to save height state:", error);
            }
        }

        if (terrainColorModifiedInStroke && colorManager) {
            console.log("Stroke ended, saving color state...");
            try {
                await colorManager.saveColorChanges();
                terrainColorModifiedInStroke = false;
            } catch(error) {
                console.error("Failed to save color state:", error);
            }
        }
    }
}

function applyBrush() {
    if (currentTool === 'select') return;

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
        let vertexModified = false;

        if (currentTool === 'color' && colorManager) {
            const appliedColor = colorManager.applyColorBrush(hitPoint, brushRadius, brushStrength);
            if (appliedColor) {
                terrainColorModifiedInStroke = true;
                vertexModified = true;
            }
            return;
        }

        let heightChanged = false;
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const strengthFactor = brushStrength * falloff * 0.15;
                const currentHeight = positions.getY(i);
                let newHeight = currentHeight;

                if (currentTool === 'raise') {
                    newHeight = currentHeight + strengthFactor;
                } else if (currentTool === 'lower') {
                    newHeight = currentHeight - strengthFactor;
                } else if (currentTool === 'flatten') {
                    newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, strengthFactor * 0.5);
                }

                if (Math.abs(newHeight - currentHeight) > 0.001) {
                    if (terrainDB) {
                        terrainDB.accumulateHeightChange(i, newHeight);
                        positions.setY(i, newHeight);
                    }
                    heightChanged = true;
                    vertexModified = true;
                }
            }
        }

        if (heightChanged) {
            positions.needsUpdate = true;
            geometry.computeVertexNormals();
            terrainHeightModifiedInStroke = true;
        }
    }
}

function updateBrushIndicator() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0 && currentTool !== 'select' && brushIndicator.visible !== false) {
        const intersection = intersects[0];
        brushIndicator.position.copy(intersection.point);
        const scale = parseFloat(brushSizeSlider.value) * 0.25;
        brushIndicator.scale.set(scale, scale, scale);
        brushIndicator.visible = true;

        if (currentTool === 'color' && colorManager) {
            brushIndicator.material.color.set(colorManager.currentColor);
            brushIndicator.material.wireframe = false;
            brushIndicator.material.opacity = 0.6;
        } else {
            brushIndicator.material.color.set(0xffffff);
            brushIndicator.material.wireframe = true;
            brushIndicator.material.opacity = 0.5;
        }
    } else {
        brushIndicator.visible = false;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

document.addEventListener('colorChanged', (event) => {
    currentTool = 'color';
    updateActiveButton();
});

async function initializeMultiplayer() {
    try {
        console.log("Initializing multiplayer...");
        await room.initialize();
        myUsername = room.peers[room.clientId].username;
        console.log(`Connected as: ${myUsername}`);

        colorManager = new ColorManager(room, geometry, scene);
        terrainDB = new TerrainDatabase(room, geometry, scene);
        playerManager = new PlayerManager(room, scene);

        colorManager.initializeColorPalette();

        const colorLoadPromise = colorManager.loadColorData();
        const terrainLoadPromise = terrainDB.loadTerrainData();

        await Promise.all([colorLoadPromise, terrainLoadPromise]);
        console.log("Initial terrain and color data loading/setup complete.");

        playerManager.initialize();

        setInterval(() => {
            if (playerManager) {
                playerManager.updatePlayerPosition(camera, controls);
            }
        }, 200);

        geometry.computeVertexNormals();
        console.log("Multiplayer initialization complete. Final geometry state applied.");
    } catch (error) {
        console.error('Error initializing multiplayer:', error);
    }
}

function animate() {
    requestAnimationFrame(animate);

    controls.update();

    if (playerManager) {
        playerManager.renderPlayerPositions();
    }

    renderer.render(scene, camera);
}

updateSliderValue(brushSizeSlider, brushSizeValueSpan);
updateSliderValue(brushStrengthSlider, brushStrengthValueSpan);
updateSliderValue(flattenHeightSlider, flattenHeightValueSpan);
updateActiveButton();

initializeMultiplayer();
animate();