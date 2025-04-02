import * as THREE from 'three';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        this.colorChanges = {};
        this.terrainColors = {};
        this.statusElement = document.getElementById('save-status');
        
        // Color palette
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
        this.allColorChanges = {};
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
            
            // Mark the first color as active by default
            if (color.hex === this.currentColor) {
                swatch.classList.add('active');
            }
            
            swatch.addEventListener('click', (e) => {
                // Prevent brush application when clicking color
                e.stopPropagation();
                
                // Update active swatch
                document.querySelectorAll('.color-swatch').forEach(s => {
                    s.classList.remove('active');
                });
                swatch.classList.add('active');
                
                // Update current color
                this.currentColor = color.hex;
                
                // Trigger event for main.js to handle
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

    // Ensure color attribute exists on geometry
    ensureColorAttribute() {
        if (!this.geometry.attributes.color) {
            const colors = new Float32Array(this.geometry.attributes.position.count * 3);
            // Initialize with default terrain color (light green)
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = 0.4;     // R
                colors[i + 1] = 0.6;  // G
                colors[i + 2] = 0.4;  // B
            }
            this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }
        
        // Enable vertex colors on the material
        if (this.terrainMesh && this.terrainMesh.material) {
            this.terrainMesh.material.vertexColors = true;
            this.terrainMesh.material.needsUpdate = true;
        }
    }

    // Apply color to terrain with brush effect
    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();
        
        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;

        // Apply color to vertices within brush radius
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i);
            // Calculate distance in the XZ plane for cylindrical brush effect
            const dx = vertex.x - hitPoint.x;
            const dz = vertex.z - hitPoint.z;
            const distance = Math.sqrt(dx * dx + dz * dz);

            if (distance < brushRadius) {
                // Smoother falloff using cosine function
                const falloff = Math.cos((distance / brushRadius) * Math.PI / 2);
                
                // Apply color with falloff for blending
                const color = new THREE.Color(this.currentColor);
                
                // If we already have a color, blend with existing
                const existingColor = new THREE.Color();
                existingColor.fromBufferAttribute(colorAttribute, i);
                
                // Lerp between existing and new color based on falloff and strength
                const blendFactor = falloff * (brushStrength / 5);
                existingColor.lerp(color, blendFactor);
                
                // Apply the color
                colorAttribute.setXYZ(i, existingColor.r, existingColor.g, existingColor.b);
                
                // Store the color change for database
                this.colorChanges[i] = '#' + existingColor.getHexString();
                
                colorModified = true;
            }
        }
        
        // If colors were modified, update the color attribute
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            return true;
        }
        
        return false;
    }

    // Save color changes to database
    async saveColorChanges() {
        if (Object.keys(this.colorChanges).length === 0) return;
        
        try {
            this.showSaveStatus(true);
            
            // Update our local state
            this.terrainColors = {...this.terrainColors, ...this.colorChanges};
            
            // Save color data to database
            await this.room.collection('terrainColorData').create({
                colorData: this.colorChanges,
                changeCount: Object.keys(this.colorChanges).length,
                timestamp: new Date().toISOString()
            });
            
            // Reset changes after saving
            const savedChanges = {...this.colorChanges};
            this.colorChanges = {};
            
            this.showSaveStatus(false);
            return savedChanges;
        } catch (error) {
            console.error('Error saving color changes:', error);
            this.showSaveStatus(false, true);
            return null;
        }
    }

    // Apply color data loaded from database
    applyColorDataToTerrain(colorData) {
        if (!colorData || typeof colorData !== 'object') {
            console.error('Invalid color data:', colorData);
            return;
        }
        
        // Store colors locally
        this.terrainColors = {...this.terrainColors, ...colorData};
        
        // Ensure color attribute exists
        this.ensureColorAttribute();
        
        // Update colors based on received data
        const colorAttribute = this.geometry.attributes.color;
        let colorModified = false;
        
        for (const [vertexIndex, colorHex] of Object.entries(colorData)) {
            const i = parseInt(vertexIndex);
            if (isNaN(i) || i < 0 || i >= colorAttribute.count) continue;
            
            // Convert hex to RGB (0-1 range)
            const color = new THREE.Color(colorHex);
            colorAttribute.setXYZ(i, color.r, color.g, color.b);
            colorModified = true;
        }
        
        if (colorModified) {
            colorAttribute.needsUpdate = true;
            console.log('Applied color data to terrain');
        }
    }

    // Initialize color data from database
    async loadColorData() {
        try {
            // Try to load color data
            const colorData = await this.room.collection('terrainColorData').getList();
            if (colorData.length > 0) {
                const latestColorData = colorData.sort((a, b) => 
                    new Date(b.created_at) - new Date(a.created_at)
                )[0];
                
                console.log('Found terrain color data from:', new Date(latestColorData.created_at));
                this.applyColorDataToTerrain(latestColorData.colorData);
                
                // Track all applied color changes
                colorData.forEach(change => {
                    this.allColorChanges[change.id] = true;
                });
            }
            
            // Subscribe to future color changes
            this.room.collection('terrainColorData').subscribe((colorChanges) => {
                if (colorChanges.length > 0) {
                    // Find the latest color update
                    const latestColorChange = colorChanges.sort((a, b) => 
                        new Date(b.created_at) - new Date(a.created_at)
                    )[0];
                    
                    // Apply color changes if we haven't seen them before
                    if (!this.allColorChanges[latestColorChange.id]) {
                        this.applyColorDataToTerrain(latestColorChange.colorData);
                        this.allColorChanges[latestColorChange.id] = true;
                    }
                }
            });
        } catch (error) {
            console.error('Error loading color data:', error);
        }
    }

    // Show save status indicator
    showSaveStatus(isVisible, isError = false) {
        if (!this.statusElement) return;
        
        this.statusElement.textContent = isError ? 'Error saving changes!' : 'Saving changes...';
        this.statusElement.style.opacity = isVisible ? '1' : '0';
        this.statusElement.style.backgroundColor = isError ? 'rgba(220,53,69,0.7)' : 'rgba(0,0,0,0.7)';
        
        if (isVisible && !isError) {
            setTimeout(() => {
                this.statusElement.style.opacity = '0';
            }, 1500);
        }
    }
}