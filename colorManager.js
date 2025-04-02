import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        // Tracks changes made *during* the current paint stroke
        this.currentStrokeColorChanges = {};
        // Represents the fully loaded/merged color state of the terrain
        this.terrainColors = {}; // Stores { vertexIndex: hexColorString }
        this.statusElement = document.getElementById('save-status');
        this.colorPalette = [
            { hex: '#66aa66', name: 'Grass Green' },
            { hex: '#228B22', name: 'Forest Green' },
            { hex: '#8B4513', name: 'Brown' },
            { hex: '#A0522D', name: 'Sienna' },
            { hex: '#C2B280', name: 'Sand' },
            { hex: '#F5DEB3', name: 'Wheat' },
            { hex: '#7393B3', name: 'Blue Gray' },
            { hex: '#FFFFFF', name: 'Snow' },
            { hex: '#808080', name: 'Gray' },
            { hex: '#2F4F4F', name: 'Dark Slate' },
            { hex: '#000000', name: 'Black' },
            { hex: '#8A9A5B', name: 'Moss Green' }
        ];
        this.currentColor = this.colorPalette[0].hex;
        // Track the ID of the single canonical color state record
        this.canonicalColorRecordId = null;
        // Track the timestamp of the currently applied color data to avoid loops
        this.lastAppliedTimestamp = null;
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
    }

    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; // Clear any existing swatches

        this.colorPalette.forEach(color => {
            const swatch = document.createElement('div');
            swatch.className = 'color-swatch';
            swatch.style.backgroundColor = color.hex;
            swatch.title = color.name;
            swatch.dataset.color = color.hex;

            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }

            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                this.currentColor = color.hex;
                const event = new CustomEvent('colorChanged', {
                    detail: {
                        color: this.currentColor,
                        name: color.name
                    }
                });
                document.dispatchEvent(event);
            });

            swatchesContainer.appendChild(swatch);
        });
    }

    ensureColorAttribute() {
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with a default base color (e.g., Grass Green)
            const defaultColor = new THREE.Color(this.colorPalette[0].hex);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        }
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();

        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const targetColor = new THREE.Color(this.currentColor);

        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const blendFactor = falloff * (brushStrength / 5); // Strength adjustment

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);

                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke
                this.currentStrokeColorChanges[i] = '#' + existingColor.getHexString();

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true; // Indicate that the geometry was modified
        }
        return false;
    }

    async saveColorChanges() {
        // Merge changes from the current stroke into the main state
        if (Object.keys(this.currentStrokeColorChanges).length > 0) {
            this.terrainColors = { ...this.terrainColors, ...this.currentStrokeColorChanges };
            this.currentStrokeColorChanges = {}; // Reset stroke changes
        } else {
            console.log("No color changes in current stroke to save.");
            return; // No need to save if nothing changed in the stroke
        }

        // Prevent saving during initial load or if no data exists
        if (this.isLoading || Object.keys(this.terrainColors).length === 0) {
            console.log("Skipping save: Still loading or no color data.");
            return;
        }

        try {
            this.showSaveStatus(true);
            const saveData = {
                colorData: this.terrainColors,
                vertexCount: Object.keys(this.terrainColors).length,
                timestamp: new Date().toISOString() // Use timestamp to track updates
            };

            if (this.canonicalColorRecordId) {
                // Update the existing record
                await this.room.collection('terrainColorState').update(this.canonicalColorRecordId, saveData);
                console.log(`Updated canonical color state record: ${this.canonicalColorRecordId}`);
            } else {
                // Create the first canonical record
                const newRecord = await this.room.collection('terrainColorState').create(saveData);
                this.canonicalColorRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = saveData.timestamp; // Set timestamp for the newly created record
                console.log(`Created canonical color state record: ${this.canonicalColorRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving color state:', error);
            this.showSaveStatus(false, true);
            // Optionally revert local state or handle error
        }
    }

    applyColorState(stateData) {
        if (!stateData || typeof stateData.colorData !== 'object') {
            console.error('Invalid color state data:', stateData);
            return false;
        }
        // Avoid re-applying the same state received via subscription
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            // console.log("Skipping application of already current color state.");
            return false;
        }

        console.log("Applying canonical color state...");
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        let applied = false;
        // Directly replace local state with the loaded state
        this.terrainColors = { ...stateData.colorData };

        // Initialize all vertices, applying saved color or default if missing
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color
        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = this.terrainColors[i];
            try {
                const color = colorHex ? new THREE.Color(colorHex) : defaultColor;
                colorAttribute.setXYZ(i, color.r, color.g, color.b);
                // Ensure local cache matches exactly what's applied, including defaults
                if (!colorHex) {
                    this.terrainColors[i] = '#' + defaultColor.getHexString();
                }
                applied = true; // Mark if any vertex was processed
            } catch (e) {
                console.warn(`Invalid color hex ${colorHex} at index ${i}. Applying default.`);
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
                this.terrainColors[i] = '#' + defaultColor.getHexString();
                applied = true;
            }
        }


        if (applied) {
            colorAttribute.needsUpdate = true;
            this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
            console.log('Applied canonical color state to terrain geometry.');
        } else {
            console.warn('No valid color data found in state record to apply.');
        }
        return applied;
    }

    async loadColorData() {
        this.isLoading = true;
        try {
            console.log("Loading canonical color state...");
            this.ensureColorAttribute(); // Make sure attribute exists

            // Fetch the list of state records (should ideally be just one)
            const states = await this.room.collection('terrainColorState').getList();
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date just in case multiple exist, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalColorRecordId = latestState.id; // Store the ID
                console.log('Applying initial color state from record:', this.canonicalColorRecordId, 'Timestamp:', latestState.timestamp);
                this.applyColorState(latestState);
            } else {
                console.log("No canonical color state found. Initializing with default colors.");
                // Initialize terrainColors with default if no state exists
                this.initializeDefaultColors();
                // Note: The first save operation will create the canonical record
            }

            // Subscribe to future updates of the canonical state record
            this.room.collection('terrainColorState').subscribe((incomingStates) => {
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    // Check if the incoming state is different from what we have applied
                    if (updatedState.id !== this.canonicalColorRecordId || updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`Received updated color state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp}). Applying...`);
                        this.canonicalColorRecordId = updatedState.id; // Update ID just in case
                        this.applyColorState(updatedState);
                    }
                } else {
                    // Handle case where the state might have been deleted?
                    console.warn("Canonical color state subscription returned empty list.");
                    // Perhaps reset to default colors or handle as appropriate
                    // this.initializeDefaultColors();
                }
            });

            console.log("Color state loading process complete.");

        } catch (error) {
            console.error('Error loading color state:', error);
            this.initializeDefaultColors(); // Fallback to default on error
        } finally {
            this.isLoading = false; // Mark loading as complete
            // Ensure geometry update after loading
            if (this.geometry.attributes.color) {
                this.geometry.attributes.color.needsUpdate = true;
            }
        }
    }

    initializeDefaultColors() {
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use first palette color
        this.terrainColors = {}; // Reset local state
        for (let i = 0; i < colorAttribute.count; i++) {
            colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            this.terrainColors[i] = this.colorPalette[0].hex;
        }
        if (colorAttribute) colorAttribute.needsUpdate = true;
        console.log("Initialized terrain with default colors locally.");
        // Do not save here, let the first user modification trigger the save/create.
    }

    showSaveStatus(isVisible, isError = false) {
        if (!this.statusElement) return;
        this.statusElement.textContent = isError ? 'Error saving color!' : 'Saving color...';
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            // Automatically hide after a short delay
            setTimeout(() => {
                if (this.statusElement.textContent === 'Saving color...') {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}