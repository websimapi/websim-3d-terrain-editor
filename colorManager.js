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
            { hex: '#66aa66', name: 'Grass Green' }, // Default grass
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
        this.currentColor = this.colorPalette[0].hex; // Default to grass
        // Track the ID of the single canonical color state record
        this.canonicalColorRecordId = null;
        // Track the timestamp of the currently applied color data to avoid loops
        this.lastAppliedTimestamp = null;
        // Flag to prevent saving while loading initial data
        this.isLoading = true;
        this.unsubscribeColor = null; // To store unsubscribe function
        // Flag to track if initial load created state
        this.initialLoadCreatedState = false;
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
        let attributeCreated = false;
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with the default base color
            const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use grass green
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r;
                colors[i + 1] = defaultColor.g;
                colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("Created initial color buffer attribute.");
            attributeCreated = true;
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        }
        return attributeCreated; // Return true if the attribute was newly created
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute(); // Ensure attribute exists

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
                // Blend factor needs care - too high strength makes it instant paint
                const blendFactor = Math.min(falloff * (brushStrength * 0.1), 1.0); // Adjust strength factor, clamp at 1

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);

                // Avoid tiny changes if possible (optional)
                // if (Math.abs(existingColor.r - colorAttribute.getX(i)) > 0.01 || ...)

                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke using the exact hex
                const newHex = '#' + existingColor.getHexString();
                this.currentStrokeColorChanges[i] = newHex;
                // Also update the canonical state cache immediately for consistency
                this.terrainColors[i] = newHex;

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true; // Mark color buffer for upload
            return true; // Indicate that the geometry was modified
        }
        return false;
    }

    async saveColorChanges() {
        // Prevent saving during initial load
        if (this.isLoading) {
            console.log("Skipping color save: Still loading initial color data.");
            return;
        }

        // Check if any changes were made *in this stroke*
        let changesFromStroke = Object.keys(this.currentStrokeColorChanges).length > 0;
        if (!changesFromStroke) {
            console.log("No color changes accumulated in the current stroke. No save needed.");
            return; // Nothing to save from this stroke
        }
        // Clear the stroke changes *before* attempting save, as terrainColors holds the latest merged state
        this.currentStrokeColorChanges = {};

        // Double check if terrainColors is actually populated
        if (Object.keys(this.terrainColors).length === 0) {
            console.warn("Attempted to save but terrainColors cache is empty. Aborting save.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving color...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, // Save the complete state from cache
                vertexCount: this.geometry.attributes.color ? this.geometry.attributes.color.count : 0, // Use actual count
                timestamp: currentTimestamp
            };

            if (saveData.vertexCount === 0) {
                console.warn("Attempted to save color state, but vertex count is 0. Aborting.");
                this.showSaveStatus(false, 'Error saving color!', true);
                return;
            }

            console.log(`Attempting to save color state. Record ID: ${this.canonicalColorRecordId}. Timestamp: ${currentTimestamp}`);

            if (this.canonicalColorRecordId) {
                // Update the existing record
                await this.room.collection('terrainColorState').update(this.canonicalColorRecordId, saveData);
                console.log(`Updated canonical color state record: ${this.canonicalColorRecordId}`);
                // Update last applied timestamp locally immediately after successful save
                this.lastAppliedTimestamp = currentTimestamp;
            } else {
                // Create the first canonical record
                console.log("Canonical color record ID not found, creating new one...");
                const newRecord = await this.room.collection('terrainColorState').create(saveData);
                this.canonicalColorRecordId = newRecord.id; // Store the new ID
                this.lastAppliedTimestamp = currentTimestamp; // Set timestamp for the newly created record
                console.log(`Created canonical color state record: ${this.canonicalColorRecordId}`);
            }

            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving color state:', error);
            this.showSaveStatus(false, 'Error saving color!', true);
        }
    }

    applyColorState(stateData) {
        console.log(`Attempting to apply color state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.colorData !== 'object') {
            console.warn('Invalid color state data received:', stateData);
            stateData = { colorData: {}, timestamp: null }; // Use default empty data for reset
        }

        // Skip if timestamp matches *unless* it's the state we just created on initial load
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp && !(this.initialLoadCreatedState && this.isLoading)) {
            console.log(`Skipping application of color state: Timestamp ${stateData.timestamp} already applied.`);
            return false; // Indicate no change was made
        }

        console.log(`Applying canonical color state (TS: ${stateData.timestamp})...`);
        this.ensureColorAttribute(); // Ensure attribute exists and material uses vertex colors
        const colorAttribute = this.geometry.attributes.color;
        // Handle case where ensureColorAttribute might fail or geometry changes unexpectedly
        if (!colorAttribute) {
            console.error("Cannot apply color state: Color attribute missing from geometry.");
            return false;
        }

        const loadedColorData = stateData.colorData || {};
        const numLoadedKeys = Object.keys(loadedColorData).length;
        console.log(`State contains ${numLoadedKeys} color entries.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color (Grass Green)
        const defaultColorHex = this.colorPalette[0].hex;
        let bufferChanged = false;

        // Clear current local state cache before applying the new one
        this.terrainColors = {};

        // Initialize all vertices, applying saved color or default if missing
        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = loadedColorData[i];
            let appliedColorHex = defaultColorHex; // Assume default initially
            const targetColor = new THREE.Color();
            let applyDefault = true;

            if (colorHex) {
                try {
                    targetColor.set(colorHex);
                    applyDefault = false;
                    appliedColorHex = colorHex;
                    verticesApplied++;
                } catch (e) {
                    console.warn(`Invalid color hex '${colorHex}' at index ${i}. Applying default (${defaultColorHex}).`);
                    targetColor.copy(defaultColor); // Use default color object
                    verticesDefaulted++;
                }
            } else {
                targetColor.copy(defaultColor);
                verticesDefaulted++;
            }

            // Get current buffer color for comparison (optional, for logging change)
            // const currentBufferColor = new THREE.Color().fromBufferAttribute(colorAttribute, i);

            // Set color in the buffer attribute
            colorAttribute.setXYZ(i, targetColor.r, targetColor.g, targetColor.b);

            // Check if buffer value actually changed (optional)
            // if (!currentBufferColor.equals(targetColor)) { bufferChanged = true; }

            // Ensure local cache matches exactly what's applied, including defaults
            this.terrainColors[i] = appliedColorHex;
        }

        console.log(`Applied color state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to ${defaultColorHex}.`);
        colorAttribute.needsUpdate = true; // Mark buffer for update
        this.lastAppliedTimestamp = stateData.timestamp; // Track the timestamp of applied data
        return true; // Indicate state was applied and buffer marked for update
    }

    async loadColorData() {
        this.isLoading = true;
        this.initialLoadCreatedState = false; // Reset flag
        if (this.unsubscribeColor) this.unsubscribeColor(); // Unsubscribe from previous listener
        this.ensureColorAttribute(); // Make sure attribute exists BEFORE loading data

        try {
            console.log("Loading canonical color state...");

            // Fetch the list of state records
            const states = await this.room.collection('terrainColorState').getList();
            console.log(`Fetched ${states.length} terrainColorState records.`);
            let latestState = null;

            if (states.length > 0) {
                // Sort by creation date, take the newest
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalColorRecordId = latestState.id; // Store the ID
                console.log(`Found latest color state record: ID=${this.canonicalColorRecordId}, Timestamp=${latestState.timestamp}`);
                this.applyColorState(latestState); // Apply initial state (sets needsUpdate)
            } else {
                console.log("No canonical color state found. Initializing terrain with default colors.");
                // Initialize terrainColors with default if no state exists, but don't save yet
                // This ensures the buffer is populated correctly even if no data is loaded.
                this.initializeDefaultColors(true); // Pass true to force apply to geometry buffer
                // We won't create the record here, the first save operation will do it.
                this.initialLoadCreatedState = true; // Mark that default state was applied due to no record
            }

            // Subscribe to future updates
            console.log(`Subscribing to terrainColorState collection...`);
            this.unsubscribeColor = this.room.collection('terrainColorState').subscribe((incomingStates) => {
                console.log(`Color subscription triggered. Received ${incomingStates.length} states.`);
                if (this.isLoading) {
                    console.log("Skipping color subscription update during initial load.");
                    return;
                }
                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`Processing color update: ID=${updatedState.id}, Timestamp=${updatedState.timestamp}, LastAppliedTS=${this.lastAppliedTimestamp}`);
                    // Apply if it's a new state for the canonical record OR if the canonical ID changed
                    let shouldApply = false;
                    if (updatedState.id === this.canonicalColorRecordId) {
                        if (updatedState.timestamp !== this.lastAppliedTimestamp) {
                            console.log(`Applying updated color state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                            shouldApply = true;
                        } else {
                            console.log(`Skipping color update: Same timestamp for canonical ID (${updatedState.timestamp}).`);
                        }
                    } else {
                        console.warn(`Canonical color record ID changed from ${this.canonicalColorRecordId} to ${updatedState.id}. Applying new state.`);
                        this.canonicalColorRecordId = updatedState.id;
                        shouldApply = true; // Apply new canonical state
                    }

                    if (shouldApply) {
                        if (this.applyColorState(updatedState)) {
                            // Geometry update (needsUpdate) handled within applyColorState
                            console.log("Geometry color updated from subscription.");
                        }
                    }
                } else {
                    console.warn("Canonical color state subscription returned empty list. This might indicate the record was deleted.");
                    // Consider resetting to default colors:
                    // this.initializeDefaultColors(true);
                }
            });

            console.log("Color state loading process complete.");

        } catch (error) {
            console.error('Error loading color state:', error);
            console.log("Applying default colors due to loading error.");
            this.initializeDefaultColors(true); // Fallback to default on error
            if (this.geometry.attributes.color) this.geometry.attributes.color.needsUpdate = true;
        } finally {
            this.isLoading = false; // Mark loading as complete
            console.log("isLoading set to false for color.");
            // Ensure geometry update after loading attempt
            if (this.geometry.attributes.color) {
                this.geometry.attributes.color.needsUpdate = true;
                console.log("Final geometry color attribute marked needsUpdate after color load process.");
            }
        }
    }

    initializeDefaultColors(forceApplyToGeometry = false) {
        const attributeExisted = !!this.geometry.attributes.color;
        const attributeCreated = this.ensureColorAttribute(); // Ensures attribute exists
        // Only apply to geometry if forced OR if the attribute was just created
        const applyToGeometry = forceApplyToGeometry || attributeCreated;

        console.log(`Initializing default colors. Force apply: ${forceApplyToGeometry}, Attribute created now: ${attributeCreated}`);

        const colorAttribute = this.geometry.attributes.color;
        if (!colorAttribute) {
            console.error("Cannot initialize default colors: Color attribute missing.");
            return;
        }

        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use first palette color
        const defaultColorHex = this.colorPalette[0].hex;
        this.terrainColors = {}; // Reset local state

        for (let i = 0; i < colorAttribute.count; i++) {
            if (applyToGeometry) {
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            }
            this.terrainColors[i] = defaultColorHex; // Update local cache regardless
        }

        if (applyToGeometry && colorAttribute) {
            colorAttribute.needsUpdate = true;
            console.log("Applied default colors to geometry buffer.");
        }
        console.log(`Initialized local terrainColors cache with default color: ${defaultColorHex}`);
        // Do not save here, let the first user modification trigger the save/create.
    }

    showSaveStatus(isVisible, message = 'Saving color...', isError = false) {
        if (!this.statusElement) return;
        // Combine messages if both height/color are saving? Maybe not needed. Use specific messages.
        this.statusElement.textContent = message; // Use passed message directly
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            // Automatically hide after a short delay
            setTimeout(() => {
                // Check if the message is still the *same saving* message before hiding
                // Allows error messages or subsequent saving messages to persist
                if (this.statusElement.textContent === message && !isError) {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}