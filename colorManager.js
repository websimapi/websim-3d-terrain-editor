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
        // Flag to prevent saving/applying during initial load
        this.isLoading = true;
        this.unsubscribeColor = null; // To store unsubscribe function
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
        } else {
            console.log("Color attribute already exists.");
        }

        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("Enabled vertex colors on material.");
        } else if (this.terrainMesh && this.terrainMesh.material && this.terrainMesh.material.vertexColors) {
            console.log("Vertex colors already enabled on material.");
        } else {
            console.warn("Terrain mesh or material not found when trying to enable vertex colors.");
        }
        // Return value not strictly needed by caller anymore, but kept for info
        return attributeCreated;
    }

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        // ensureColorAttribute is called before loading now, so it should exist
        if (!this.geometry.attributes.color) {
            console.error("Cannot apply color brush: Color attribute missing.");
            return false;
        }

        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;
        const targetColor = new THREE.Color(this.currentColor);

        for (let i = 0; i < positions.count; i++) {
            // ... (existing distance check) ...
            vertex.fromBufferAttribute(positions, i);
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                // ... (existing falloff and blendFactor calculation) ...
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const blendFactor = Math.min(falloff * (brushStrength * 0.1), 1.0); // Adjust strength factor, clamp at 1

                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                // Store hex BEFORE lerping for comparison/logging if needed
                // const oldHex = '#' + existingColor.getHexString();

                existingColor.lerp(targetColor, blendFactor);

                // Apply color to buffer attribute
                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);

                // Store the change for this stroke using the exact hex
                const newHex = '#' + existingColor.getHexString();
                this.currentStrokeColorChanges[i] = newHex;
                // Also update the canonical state cache immediately for consistency
                // If we paint over the same spot multiple times in a stroke, this keeps the latest
                this.terrainColors[i] = newHex;

                colorModified = true;
            }
        }

        if (colorModified) {
            colorAttribute.needsUpdate = true; // Mark buffer for update
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

        // Check if there are any changes accumulated in the current stroke
        let changesFromStroke = Object.keys(this.currentStrokeColorChanges).length > 0;
        if (!changesFromStroke) {
            console.log("No color changes accumulated in the current stroke. No save needed.");
            this.currentStrokeColorChanges = {}; // Ensure it's clear anyway
            return; // Nothing to save
        }

        // Merge stroke changes into the main state cache (terrainColors)
        // This is slightly redundant as applyColorBrush already updates terrainColors,
        // but it ensures consistency if the logic were to change.
        console.log(`Merging ${Object.keys(this.currentStrokeColorChanges).length} color changes from stroke into canonical state.`);
        Object.assign(this.terrainColors, this.currentStrokeColorChanges);
        this.currentStrokeColorChanges = {}; // Reset stroke changes *after* successful merge

        // Double check if terrainColors is actually populated (should be after load or default init)
        if (Object.keys(this.terrainColors).length === 0) {
            console.warn("Attempted to save but terrainColors is empty after merge. Aborting save.");
            return;
        }

        // We need the vertex count from the geometry's color attribute
        if (!this.geometry.attributes.color) {
            console.error("Cannot save color state: Geometry color attribute missing.");
            this.showSaveStatus(false, 'Save Error: No Color Attr!', true);
            throw new Error("Cannot save color: Geometry missing color attribute")
        }
        const vertexCount = this.geometry.attributes.color.count;

        try {
            this.showSaveStatus(true, 'Saving color...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, // Save the complete state
                vertexCount: vertexCount, // Use actual count from geometry
                timestamp: currentTimestamp
            };

            console.log(`Attempting to save color state. Record ID: ${this.canonicalColorRecordId}. Timestamp: ${currentTimestamp}`);

            if (this.canonicalColorRecordId) {
                // Update the existing record
                console.log(`Updating existing color record: ${this.canonicalColorRecordId}`);
                await this.room.collection('terrainColorState').update(this.canonicalColorRecordId, saveData);
                console.log(`Updated canonical color state record: ${this.canonicalColorRecordId}`);
            } else {
                // Create the first canonical record if it doesn't exist yet
                console.log("Canonical color record ID not found, creating new one...");
                const newRecord = await this.room.collection('terrainColorState').create(saveData);
                this.canonicalColorRecordId = newRecord.id; // Store the new ID
                console.log(`Created canonical color state record: ${this.canonicalColorRecordId}`);
            }

            // Update last applied timestamp locally immediately after successful save/create
            this.lastAppliedTimestamp = currentTimestamp;
            this.showSaveStatus(false);

        } catch (error) {
            console.error('Error saving color state:', error);
            this.showSaveStatus(false, 'Error saving color!', true);
            // Don't clear terrainColors, keep the last known good state?
            // Clear stroke changes to avoid resaving failed data
            this.currentStrokeColorChanges = {};
            throw error; // Re-throw so Promise.all in onPointerUp knows it failed
        } finally {
            // Ensure stroke changes are always cleared after a save attempt
            // Moved inside try/catch
        }
    }

    applyColorState(stateData) {
        const incomingTimestamp = stateData?.timestamp || stateData?.created_at;
        console.log(`Attempting to apply color state. Incoming TS: ${incomingTimestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);

        // Ensure color attribute exists before trying to apply
        // This is usually called before load, but good safety check
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        if (!colorAttribute) {
            console.error("Cannot apply color state: Geometry color attribute is missing.");
            return false;
        }

        if (!stateData || typeof stateData.colorData !== 'object') {
            console.warn('Invalid color state data received:', stateData);
            // Use default empty data for reset, generate unique timestamp
            stateData = { colorData: {}, timestamp: `invalid-${Date.now()}` };
        }

        // Avoid re-applying the same state received via subscription or initial load
        if (incomingTimestamp && incomingTimestamp === this.lastAppliedTimestamp) {
            console.log(`Skipping application of color state: Timestamp ${incomingTimestamp} already applied.`);
            return false; // Indicate no change was made
        }

        console.log(`Applying canonical color state (TS: ${incomingTimestamp})...`);
        const loadedColorData = stateData.colorData || {};
        const numLoadedKeys = Object.keys(loadedColorData).length;
        console.log(`State contains ${numLoadedKeys} color entries for ${colorAttribute.count} vertices.`);
        let verticesApplied = 0;
        let verticesDefaulted = 0;
        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Fallback color (Grass Green)
        const defaultColorHex = this.colorPalette[0].hex;

        // Clear current local state before applying the new one
        this.terrainColors = {};

        // Initialize all vertices, applying saved color or default if missing
        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = loadedColorData[i];
            let appliedColorHex = defaultColorHex; // Assume default initially
            let appliedColor = defaultColor; // Use THREE.Color object for application

            if (colorHex && typeof colorHex === 'string') {
                try {
                    // Use a temporary color object to parse hex
                    const tempColor = new THREE.Color(colorHex);
                    appliedColor = tempColor; // Use the parsed color
                    appliedColorHex = colorHex; // Store the original valid hex
                    verticesApplied++;
                } catch (e) {
                    console.warn(`Invalid color hex '${colorHex}' at index ${i}. Applying default (${defaultColorHex}).`);
                    // appliedColor remains defaultColor
                    appliedColorHex = defaultColorHex;
                    verticesDefaulted++;
                }
            } else {
                // appliedColor remains defaultColor
                appliedColorHex = defaultColorHex;
                verticesDefaulted++;
            }

            // Apply color to the buffer attribute
            colorAttribute.setXYZ(i, appliedColor.r, appliedColor.g, appliedColor.b);

            // Ensure local cache matches exactly what's applied, including defaults
            this.terrainColors[i] = appliedColorHex;
        }

        console.log(`Applied color state: ${verticesApplied} vertices from data, ${verticesDefaulted} defaulted to ${defaultColorHex}.`);
        // Mark buffer for update - caller (load or subscription) handles this now
        // colorAttribute.needsUpdate = true;
        this.lastAppliedTimestamp = incomingTimestamp; // Track the timestamp of applied data
        return true; // Indicate state was applied
    }

    async loadColorData() {
        this.isLoading = true; // Ensure loading flag is set
        if (this.unsubscribeColor) {
            console.log("Unsubscribing from previous color listener.");
            this.unsubscribeColor();
            this.unsubscribeColor = null;
        }
        // Ensure attribute exists BEFORE loading data - called in initializeMultiplayer now
        // this.ensureColorAttribute();

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
                console.log(`Found latest color state record: ID=${this.canonicalColorRecordId}, Timestamp=${latestState.timestamp || latestState.created_at}`);
                // Apply initial state - updates local cache and geometry colors
                this.applyColorState(latestState);
            } else {
                console.log("No canonical color state found. Initializing terrain with default colors.");
                // Initialize terrainColors cache AND geometry with default colors.
                // Use a unique timestamp to ensure it's considered "applied"
                this.initializeDefaultColors(true, `init-${Date.now()}`);
                // Note: The first save operation (from a paint stroke) will create the canonical record.
            }

            // Subscribe to future updates AFTER initial load/creation attempt
            console.log(`Subscribing to terrainColorState collection...`);
            this.unsubscribeColor = this.room.collection('terrainColorState').subscribe((incomingStates) => {
                // --- Subscription Callback ---
                if (this.isLoading) {
                    console.log("Color subscription triggered, but skipping update: Still in initial loading phase.");
                    return; // Do nothing if still loading initial data
                }
                console.log(`Color subscription triggered. Received ${incomingStates.length} states.`);

                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    const updateTimestamp = updatedState.timestamp || updatedState.created_at;
                    console.log(`Processing color update: ID=${updatedState.id}, Timestamp=${updateTimestamp}, LastAppliedTS=${this.lastAppliedTimestamp}`);

                    // Apply if it's a new state for the canonical record OR if the canonical ID changed
                    if (updatedState.id === this.canonicalColorRecordId && updateTimestamp !== this.lastAppliedTimestamp) {
                        console.log(`Applying updated color state via subscription (ID: ${updatedState.id}, TS: ${updateTimestamp})`);
                        if (this.applyColorState(updatedState)) {
                            // Ensure geometry reflects the update
                            if (this.geometry.attributes.color) {
                                this.geometry.attributes.color.needsUpdate = true;
                                console.log("Geometry color updated from subscription.");
                            } else {
                                console.error("Color attribute missing after applying subscription update!");
                            }
                        }
                    } else if (updatedState.id !== this.canonicalColorRecordId) {
                        console.warn(`Canonical color record ID changed from ${this.canonicalColorRecordId} to ${updatedState.id}. Applying new state.`);
                        this.canonicalColorRecordId = updatedState.id;
                        if (this.applyColorState(updatedState)) {
                            if (this.geometry.attributes.color) {
                                this.geometry.attributes.color.needsUpdate = true;
                                console.log("Geometry color updated from new canonical color ID.");
                            } else {
                                console.error("Color attribute missing after applying new canonical ID update!");
                            }
                        }
                    } else {
                        console.log("Skipping color update: Same timestamp or non-canonical ID.");
                    }
                } else {
                    console.warn("Canonical color state subscription returned empty list. This might indicate the record was deleted.");
                    // Optional: Reset to default colors if canonical record disappears?
                    // this.initializeDefaultColors(true, `deleted-${Date.now()}`);
                    // if (this.geometry.attributes.color) this.geometry.attributes.color.needsUpdate = true;
                }
                // --- End Subscription Callback ---
            });

            console.log("Color state loading process complete.");

        } catch (error) {
            console.error('Error loading color state:', error);
            console.warn("Applying default colors due to loading error.");
            // Fallback: apply default colors and set applied timestamp
            this.initializeDefaultColors(true, `error-${Date.now()}`); // Fallback to default on error
        } finally {
            this.isLoading = false; // Mark loading as complete *after* all setup/subscribe
            console.log("isLoading set to false for color.");
            // Note: Final geometry update (needsUpdate) is handled in initializeMultiplayer in main.js
        }
    }

    // Initialize local cache and optionally geometry with default colors
    initializeDefaultColors(applyToGeometry = false, appliedTimestamp = null) {
        // Ensure attribute exists first - called in initializeMultiplayer now
        // const attributeCreated = this.ensureColorAttribute();
        // const applyToGeometry = forceApplyToGeometry || attributeCreated; // Apply if forced or newly created

        console.log(`Initializing default colors. Apply to Geometry: ${applyToGeometry}`);

        const colorAttribute = this.geometry.attributes.color;
        if (!colorAttribute && applyToGeometry) {
            console.error("Cannot apply default colors to geometry: Color attribute missing.");
            applyToGeometry = false; // Can't apply if it doesn't exist
        }

        const defaultColor = new THREE.Color(this.colorPalette[0].hex); // Use first palette color
        const defaultColorHex = this.colorPalette[0].hex;
        this.terrainColors = {}; // Reset local state

        for (let i = 0; i < this.geometry.attributes.position.count; i++) { // Use position count as reference
            if (applyToGeometry && colorAttribute) {
                colorAttribute.setXYZ(i, defaultColor.r, defaultColor.g, defaultColor.b);
            }
            // Update local cache regardless of geometry application
            this.terrainColors[i] = defaultColorHex;
        }

        if (applyToGeometry && colorAttribute) {
            colorAttribute.needsUpdate = true; // Mark buffer if we changed it
            console.log("Applied default colors to geometry buffer.");
        }
        console.log(`Initialized local terrainColors cache with default color: ${defaultColorHex}`);

        // Set the timestamp if provided, indicating this state has been "applied"
        if (appliedTimestamp) {
            this.lastAppliedTimestamp = appliedTimestamp;
            console.log(`Set lastAppliedTimestamp to ${appliedTimestamp} after applying default colors.`);
        }
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