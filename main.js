import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // Sky blue background

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 50, 50); // Elevated view

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true; // Enable shadows
document.body.appendChild(renderer.domElement);

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
directionalLight.position.set(50, 100, 25);
directionalLight.castShadow = true;
// Configure shadow properties for better quality
directionalLight.shadow.mapSize.width = 2048;
directionalLight.shadow.mapSize.height = 2048;
directionalLight.shadow.camera.near = 0.5;
directionalLight.shadow.camera.far = 500;
directionalLight.shadow.camera.left = -100;
directionalLight.shadow.camera.right = 100;
directionalLight.shadow.camera.top = 100;
directionalLight.shadow.camera.bottom = -100;
scene.add(directionalLight);
// const helper = new THREE.CameraHelper( directionalLight.shadow.camera );
// scene.add( helper ); // Uncomment to visualize shadow camera


// --- Terrain ---
const terrainSize = 100;
const terrainSegments = 100; // Increase for more detail
const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
geometry.rotateX(-Math.PI / 2); // Rotate to be horizontal

const material = new THREE.MeshStandardMaterial({
    color: 0x55aa55, // Greenish color
    // wireframe: true, // Uncomment to see wireframe
    side: THREE.DoubleSide, // Render both sides
    metalness: 0.1,
    roughness: 0.8
});

const terrain = new THREE.Mesh(geometry, material);
terrain.receiveShadow = true; // Allow terrain to receive shadows
terrain.castShadow = true; // Allow terrain to cast shadows
scene.add(terrain);

// Store original vertices for flattening reference if needed later
// const originalVertices = geometry.attributes.position.array.slice();

// --- Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // Smooth camera movement
controls.dampingFactor = 0.1;
controls.target.set(0, 0, 0); // Focus on the center of the terrain


// --- Terrain Editing ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isMouseDown = false;
let currentTool = 'raise'; // 'raise', 'lower', 'flatten'

// --- Control Panel Elements ---
const brushSizeSlider = document.getElementById('brushSize');
const brushStrengthSlider = document.getElementById('brushStrength');
const flattenHeightSlider = document.getElementById('flattenHeight');
const raiseBtn = document.getElementById('raiseBtn');
const lowerBtn = document.getElementById('lowerBtn');
const flattenBtn = document.getElementById('flattenBtn');
const controlButtons = [raiseBtn, lowerBtn, flattenBtn];

function updateActiveButton() {
    controlButtons.forEach(btn => {
        if (btn.id.startsWith(currentTool)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    flattenHeightSlider.parentElement.style.display = currentTool === 'flatten' ? 'block' : 'none'; // Show/hide flatten height slider
}

raiseBtn.addEventListener('click', () => { currentTool = 'raise'; updateActiveButton(); });
lowerBtn.addEventListener('click', () => { currentTool = 'lower'; updateActiveButton(); });
flattenBtn.addEventListener('click', () => { currentTool = 'flatten'; updateActiveButton(); });


// --- Mouse Event Listeners ---
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mousedown', onMouseDown);
window.addEventListener('mouseup', onMouseUp);
window.addEventListener('resize', onWindowResize);

function onMouseMove(event) {
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    if (isMouseDown) {
        applyBrush();
    }
}

function onMouseDown(event) {
    // Prevent OrbitControls from interfering when clicking on controls
    if (event.target.closest('#controls')) return;

    isMouseDown = true;
    controls.enabled = false; // Disable camera controls while editing
    applyBrush(); // Apply brush even on single click
}

function onMouseUp() {
    isMouseDown = false;
    controls.enabled = true; // Re-enable camera controls
}

function applyBrush() {
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(terrain);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const hitPoint = intersection.point;
        const faceIndex = intersection.faceIndex; // Useful for getting vertex indices

        const brushRadius = parseFloat(brushSizeSlider.value);
        const brushStrength = parseFloat(brushStrengthSlider.value);
        const targetFlattenHeight = parseFloat(flattenHeightSlider.value);

        const positions = geometry.attributes.position;
        const vertex = new THREE.Vector3();

        // Iterate through all vertices
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const distance = vertex.distanceTo(hitPoint);

            if (distance < brushRadius) {
                // Calculate falloff (smooth effect) - simple linear falloff for now
                // More complex falloff (e.g., smoothstep or Gaussian) can be used
                const falloff = Math.max(0, 1 - distance / brushRadius); // Linear falloff
                // const falloff = Math.pow(Math.cos((distance / brushRadius) * Math.PI / 2), 2); // Cosine falloff (smoother)


                let newHeight = positions.getY(i);

                if (currentTool === 'raise') {
                    newHeight += falloff * brushStrength * 0.1; // Adjust multiplier for sensitivity
                } else if (currentTool === 'lower') {
                    newHeight -= falloff * brushStrength * 0.1;
                } else if (currentTool === 'flatten') {
                    // Smoothly interpolate towards the target flatten height
                    const currentHeight = positions.getY(i);
                    newHeight = THREE.MathUtils.lerp(currentHeight, targetFlattenHeight, falloff * brushStrength * 0.1); // Use lerp for smooth flattening
                }

                positions.setY(i, newHeight);
            }
        }

        // Mark attribute as needing update and recompute normals
        positions.needsUpdate = true;
        geometry.computeVertexNormals();
    }
}


function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);
    controls.update(); // Only required if enableDamping or autoRotate are set to true
    renderer.render(scene, camera);
}

// Initial setup calls
updateActiveButton(); // Set initial active button state
animate();

