import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        this.currentStrokeColorChanges = {};
        this.terrainColors = {}; 
        this.statusElement = document.getElementById('save-status');
        this.colorPalette = [
             { hex: '#66aa66', name: 'Grass Green' }, { hex: '#228B22', name: 'Forest Green' },
             { hex: '#8B4513', name: 'Brown' }, { hex: '#A0522D', name: 'Sienna' },
             { hex: '#C2B280', name: 'Sand' }, { hex: '#F5DEB3', name: 'Wheat' },
             { hex: '#7393B3', name: 'Blue Gray' }, { hex: '#FFFFFF', name: 'Snow' },
             { hex: '#808080', name: 'Gray' }, { hex: '#2F4F4F', name: 'Dark Slate' },
             { hex: '#000000', name: 'Black' }, { hex: '#8A9A5B', name: 'Moss Green' }
        ];
        this.defaultColorHex = this.colorPalette[0].hex; 
        this.currentColor = this.defaultColorHex;
        this.canonicalColorRecordId = null;
        this.lastAppliedTimestamp = null;
        this.isLoading = true;
        this.unsubscribeColor = null;
        this.collectionName = 'terrainColorState'; 
    }

    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; 

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
                document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
                this.currentColor = color.hex;
                document.dispatchEvent(new CustomEvent('colorChanged', { detail: { color: this.currentColor, name: color.name } }));
            });
            swatchesContainer.appendChild(swatch);
        });
    }

    ensureColorAttribute() {
        let attributeCreated = false;
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            const defaultColor = new THREE.Color(this.defaultColorHex);
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = defaultColor.r; colors[i + 1] = defaultColor.g; colors[i + 2] = defaultColor.b;
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            console.log("[ColorMgr] Created initial color buffer attribute.");
            attributeCreated = true;
        }
        if (this.terrainMesh && this.terrainMesh.material && !this.terrainMesh.material.vertexColors) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
            console.log("[ColorMgr] Enabled vertex colors on material.");
        }
        return attributeCreated;
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
            const dx = vertex.x - hitPoint.x; const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                const blendFactor = Math.min(falloff * (brushStrength * 0.1), 1.0);
                const existingColor = new THREE.Color().fromBufferAttribute(colorAttribute, i);
                existingColor.lerp(targetColor, blendFactor);
                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);
                const newHex = '#' + existingColor.getHexString();
                this.currentStrokeColorChanges[i] = newHex;
                this.terrainColors[i] = newHex; 
                colorModified = true;
            }
        }
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true;
        }
        return false;
    }

    async saveColorChanges() {
        if (this.isLoading) {
            console.log("[ColorMgr] Skipping color save: Still loading.");
            return;
        }
        let changesFromStroke = Object.keys(this.currentStrokeColorChanges).length > 0;
        if (changesFromStroke) {
            console.log(`[ColorMgr] Merging ${Object.keys(this.currentStrokeColorChanges).length} color changes from stroke.`);
            this.terrainColors = { ...this.terrainColors, ...this.currentStrokeColorChanges };
            this.currentStrokeColorChanges = {};
        } else {
            console.log("[ColorMgr] No color changes in stroke. No save needed.");
            return;
        }

        if (Object.keys(this.terrainColors).length === 0) {
            console.warn("[ColorMgr] Attempted to save but terrainColors is empty. Aborting.");
            return;
        }

        try {
            this.showSaveStatus(true, 'Saving color...');
            const currentTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors,
                vertexCount: this.geometry.attributes.color.count,
                timestamp: currentTimestamp
            };
            console.log(`[ColorMgr] Attempting to save color state to "${this.collectionName}". Record ID: ${this.canonicalColorRecordId}. TS: ${currentTimestamp}`);

            if (this.canonicalColorRecordId) {
                await this.room.collection(this.collectionName).update(this.canonicalColorRecordId, saveData);
                console.log(`[ColorMgr] Updated canonical color state record: ${this.canonicalColorRecordId}`);
                this.lastAppliedTimestamp = currentTimestamp;
            } else {
                console.log(`[ColorMgr] Canonical color record ID (${this.canonicalColorRecordId}) not found, creating new one...`);
                const newRecord = await this.room.collection(this.collectionName).create(saveData);
                this.canonicalColorRecordId = newRecord.id;
                this.lastAppliedTimestamp = currentTimestamp;
                console.log(`[ColorMgr] Created new canonical color state record: ${this.canonicalColorRecordId}`);
            }
            this.showSaveStatus(false);
        } catch (error) {
            console.error(`[ColorMgr] Error saving color state to "${this.collectionName}":`, error);
            this.showSaveStatus(false, 'Error saving color!', true);
        } finally {
        }
    }

    applyColorState(stateData) {
        console.log(`[ColorMgr] Attempting to apply color state. Incoming TS: ${stateData?.timestamp}, Last Applied TS: ${this.lastAppliedTimestamp}`);
        if (!stateData || typeof stateData.colorData !== 'object') {
            console.warn('[ColorMgr] Invalid color state data received:', stateData);
            stateData = { colorData: {}, timestamp: null }; 
        }
        if (stateData.timestamp && stateData.timestamp === this.lastAppliedTimestamp) {
            console.log(`[ColorMgr] Skipping application of color state: Timestamp ${stateData.timestamp} already applied.`);
            return false;
        }

        console.log(`[ColorMgr] Applying canonical color state (TS: ${stateData.timestamp})...`);
        this.ensureColorAttribute();
        const colorAttribute = this.geometry.attributes.color;
        const loadedColorData = stateData.colorData || {};
        console.log(`[ColorMgr] State contains ${Object.keys(loadedColorData).length} color entries.`);
        let verticesApplied = 0; let verticesDefaulted = 0;
        const defaultColor3 = new THREE.Color(this.defaultColorHex);

        this.terrainColors = {}; 

        for (let i = 0; i < colorAttribute.count; i++) {
            const colorHex = loadedColorData[i];
            let appliedColorHex = this.defaultColorHex;
            try {
                const color = colorHex ? new THREE.Color(colorHex) : defaultColor3;
                colorAttribute.setXYZ(i, color.r, color.g, color.b);
                appliedColorHex = colorHex ? colorHex : this.defaultColorHex;
                if (colorHex) verticesApplied++; else verticesDefaulted++;
            } catch (e) {
                console.warn(`[ColorMgr] Invalid color hex '${colorHex}' at index ${i}. Applying default (${this.defaultColorHex}).`);
                colorAttribute.setXYZ(i, defaultColor3.r, defaultColor3.g, defaultColor3.b);
                verticesDefaulted++;
                appliedColorHex = this.defaultColorHex;
            }
            this.terrainColors[i] = appliedColorHex; 
        }
        console.log(`[ColorMgr] Applied color state: ${verticesApplied} from data, ${verticesDefaulted} defaulted to ${this.defaultColorHex}.`);
        colorAttribute.needsUpdate = true;
        this.lastAppliedTimestamp = stateData.timestamp;
        return true;
    }

    async loadColorData() {
        this.isLoading = true;
        if (this.unsubscribeColor) this.unsubscribeColor();
        this.ensureColorAttribute(); 

        try {
            console.log(`[ColorMgr] Loading canonical state from collection: "${this.collectionName}"...`);
            const states = await this.room.collection(this.collectionName).getList();
            console.log(`[ColorMgr] Fetched ${states.length} records from "${this.collectionName}". Raw:`, JSON.stringify(states)); 
            let latestState = null;

            if (states.length > 0) {
                latestState = states.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                this.canonicalColorRecordId = latestState.id;
                console.log(`[ColorMgr] Found latest state record: ID=${this.canonicalColorRecordId}, TS=${latestState.timestamp}`);
                if (this.applyColorState(latestState)) {
                    console.log(`[ColorMgr] Applied initial color state ID: ${this.canonicalColorRecordId}`);
                } else {
                    console.log(`[ColorMgr] Initial state ID: ${this.canonicalColorRecordId} was already applied (based on timestamp).`);
                }
            } else {
                console.log(`[ColorMgr] No canonical state found in "${this.collectionName}". Initializing with default colors.`);
                await this.createDefaultColorStateRecord(); 
            }

            console.log(`[ColorMgr] Subscribing to "${this.collectionName}" collection...`);
            this.unsubscribeColor = this.room.collection(this.collectionName).subscribe((incomingStates) => {
                console.log(`[ColorMgr] Subscription triggered. Received ${incomingStates.length} states from "${this.collectionName}".`);
                if (this.isLoading) { console.log("[ColorMgr] Skipping subscription update during initial load."); return; }

                if (incomingStates.length > 0) {
                    const updatedState = incomingStates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                    console.log(`[ColorMgr] Processing subscription update: ID=${updatedState.id}, TS=${updatedState.timestamp}, LastAppliedTS=${this.lastAppliedTimestamp}, CanonicalID=${this.canonicalColorRecordId}`);
                    if (updatedState.id === this.canonicalColorRecordId && updatedState.timestamp !== this.lastAppliedTimestamp) {
                        console.log(`[ColorMgr] Applying updated color state via subscription (ID: ${updatedState.id}, TS: ${updatedState.timestamp})`);
                        if(this.applyColorState(updatedState)) {
                            console.log("[ColorMgr] Geometry color updated from subscription."); 
                        }
                    } else if (updatedState.id !== this.canonicalColorRecordId) {
                        console.warn(`[ColorMgr] Canonical color record ID changed from ${this.canonicalColorRecordId} to ${updatedState.id}. Applying new state.`);
                        this.canonicalColorRecordId = updatedState.id;
                        if(this.applyColorState(updatedState)) { console.log("[ColorMgr] Geometry color updated from new canonical ID."); }
                    } else {
                        console.log("[ColorMgr] Skipping color update: Same timestamp or non-canonical ID.");
                    }
                } else {
                    console.warn(`[ColorMgr] Canonical state subscription for "${this.collectionName}" returned empty list. Record might be deleted.`);
                }
            });
            console.log(`[ColorMgr] State loading process complete for "${this.collectionName}".`);
        } catch (error) {
            console.error(`[ColorMgr] Error loading color state from "${this.collectionName}":`, error);
            console.log("[ColorMgr] Applying default colors due to loading error.");
            this.resetToDefaultState(); 
        } finally {
            this.isLoading = false;
            console.log(`[ColorMgr] isLoading set to false for "${this.collectionName}".`);
            if (this.geometry.attributes.color) {
                this.geometry.attributes.color.needsUpdate = true;
                console.log(`[ColorMgr] Final geometry color update check after load process for "${this.collectionName}".`);
            }
        }
    }

    initializeDefaultColorsLocally() {
        const attributeCreated = this.ensureColorAttribute();
        console.log(`[ColorMgr] Initializing default colors locally.`);
        const colorAttribute = this.geometry.attributes.color;
        const defaultColor3 = new THREE.Color(this.defaultColorHex);
        this.terrainColors = {}; 

        for (let i = 0; i < colorAttribute.count; i++) {
            colorAttribute.setXYZ(i, defaultColor3.r, defaultColor3.g, defaultColor3.b);
            this.terrainColors[i] = this.defaultColorHex; 
        }
        colorAttribute.needsUpdate = true;
        console.log(`[ColorMgr] Initialized local terrainColors cache & geometry buffer with default: ${this.defaultColorHex}`);
    }

    async createDefaultColorStateRecord() {
        try {
            console.log(`[ColorMgr] Creating initial default color state record in "${this.collectionName}"...`);
            this.initializeDefaultColorsLocally(); 

            const initialTimestamp = new Date().toISOString();
            const saveData = {
                colorData: this.terrainColors, 
                vertexCount: this.geometry.attributes.color.count,
                isInitial: true,
                timestamp: initialTimestamp
            };

            console.log("[ColorMgr] Applying initial default state locally before save.");
            this.applyColorState(saveData); 

            console.log(`[ColorMgr] Sending create request for initial default color state to "${this.collectionName}"...`);
            const stateRecord = await this.room.collection(this.collectionName).create(saveData);
            this.canonicalColorRecordId = stateRecord.id;
            console.log(`[ColorMgr] Created and saved initial default color state record: ${this.canonicalColorRecordId}, TS: ${this.lastAppliedTimestamp}`);
            return this.terrainColors;

        } catch (error) {
            console.error(`[ColorMgr] Error creating default color state record in "${this.collectionName}":`, error);
            throw error;
        }
    }

    resetToDefaultState() {
        console.log("[ColorMgr] Resetting terrain color to default locally.");
        const defaultStateData = {
            colorData: {}, 
            timestamp: null
        };
        if (this.applyColorState(defaultStateData)) {
            console.log("[ColorMgr] Geometry color updated after resetToDefaultState.");
        }
        this.canonicalColorRecordId = null;
        this.lastAppliedTimestamp = null;
    }

    showSaveStatus(isVisible, message = 'Saving color...', isError = false) {
        if (!this.statusElement) return;
        this.statusElement.textContent = message;
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        if (isVisible && !isError) {
            setTimeout(() => {
                if (this.statusElement.textContent === message && !isError) {
                    this.statusElement.style.opacity = '0';
                }
            }, 1500);
        }
    }
}