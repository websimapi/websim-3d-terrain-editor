import * as THREE from 'three';
import { TextureHandler } from './textureHandler.js';

export class ColorManager {
    constructor(room, geometry, scene) {
        this.room = room;
        this.geometry = geometry;
        this.scene = scene;
        this.terrainMesh = scene.getObjectByName('terrain');
        this.colorChanges = {};
        this.terrainColors = {};
        this.statusElement = document.getElementById('save-status');
        this.textureHandler = new TextureHandler();
        
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
        this.customTextures = [];
    }

    initializeColorPalette() {
        const swatchesContainer = document.getElementById('colorSwatches');
        swatchesContainer.innerHTML = ''; // Clear any existing swatches
        
        // Add the custom texture button first
        const generateButton = document.createElement('div');
        generateButton.className = 'color-swatch generate-texture';
        generateButton.style.background = 'linear-gradient(45deg, rgba(0,0,0,0.3) 25%, transparent 25%, transparent 50%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.3) 75%, transparent 75%, transparent)';
        generateButton.style.backgroundSize = '10px 10px';
        generateButton.innerHTML = '<span style="font-size: 20px;">+</span>';
        generateButton.title = 'Generate Custom Texture';
        generateButton.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTextureGeneratorModal();
        });
        swatchesContainer.appendChild(generateButton);
        
        // Add custom textures
        this.customTextures.forEach(texture => {
            this.addTextureToSwatches(texture, swatchesContainer);
        });
        
        // Add built-in color palette
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
                        name: color.name,
                        isTexture: false
                    }
                });
                document.dispatchEvent(event);
            });
            
            swatchesContainer.appendChild(swatch);
        });
    }

    addTextureToSwatches(texture, container) {
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch texture-swatch';
        swatch.style.backgroundImage = `url(${texture.url})`;
        swatch.style.backgroundSize = 'cover';
        swatch.title = texture.name;
        swatch.dataset.textureUrl = texture.url;
        
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Update active swatch
            document.querySelectorAll('.color-swatch').forEach(s => {
                s.classList.remove('active');
            });
            swatch.classList.add('active');
            
            // Update current color/texture
            this.currentColor = texture.url;
            
            // Trigger event for main.js to handle
            const event = new CustomEvent('colorChanged', {
                detail: {
                    color: texture.url,
                    name: texture.name,
                    isTexture: true
                }
            });
            document.dispatchEvent(event);
        });
        
        if (container) {
            // Insert after the generate button
            const firstColor = container.querySelector('.color-swatch:not(.generate-texture)');
            if (firstColor) {
                container.insertBefore(swatch, firstColor);
            } else {
                container.appendChild(swatch);
            }
        }
        
        return swatch;
    }

    showTextureGeneratorModal() {
        // Create modal if it doesn't exist
        let modal = document.getElementById('texture-generator-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'texture-generator-modal';
            modal.className = 'texture-modal';
            modal.innerHTML = `
                <div class="texture-modal-content">
                    <span class="texture-modal-close">&times;</span>
                    <h2>Generate Custom Terrain Texture</h2>
                    <p>Describe the terrain texture you want to generate:</p>
                    <textarea id="texture-prompt" placeholder="e.g., Volcanic rock with lava flows" rows="3"></textarea>
                    <div class="texture-preview-container">
                        <img id="texture-preview" style="display: none; max-width: 100%;" />
                        <div id="texture-loading" style="display: none;">Generating texture...</div>
                    </div>
                    <div class="texture-buttons">
                        <button id="generate-texture-btn">Generate</button>
                        <button id="save-texture-btn" disabled>Add to Palette</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            
            // Add event listeners
            modal.querySelector('.texture-modal-close').addEventListener('click', () => {
                modal.style.display = 'none';
            });
            
            const generateBtn = document.getElementById('generate-texture-btn');
            const saveBtn = document.getElementById('save-texture-btn');
            const texturePreview = document.getElementById('texture-preview');
            const textureLoading = document.getElementById('texture-loading');
            
            generateBtn.addEventListener('click', async () => {
                const prompt = document.getElementById('texture-prompt').value.trim();
                if (!prompt) {
                    alert('Please enter a description for your texture');
                    return;
                }
                
                // Show loading state
                generateBtn.disabled = true;
                texturePreview.style.display = 'none';
                textureLoading.style.display = 'block';
                
                try {
                    // Generate the texture using the AI image generation API
                    const enhancedPrompt = `A seamless top-down terrain texture showing ${prompt}. Tileable pattern for video game terrain, flat lighting, no shadows, overhead view`;
                    const result = await websim.imageGen({
                        prompt: enhancedPrompt,
                        aspect_ratio: "1:1"
                    });
                    
                    // Try to upload the image to websim storage to avoid CORS issues
                    let textureUrl = result.url;
                    try {
                        const response = await fetch(result.url);
                        const blob = await response.blob();
                        const file = new File([blob], 'texture.jpg', { type: 'image/jpeg' });
                        textureUrl = await websim.upload(file);
                    } catch (err) {
                        console.warn('Could not upload texture to websim storage, using original URL', err);
                    }
                    
                    // Display the generated texture
                    texturePreview.src = textureUrl;
                    texturePreview.style.display = 'block';
                    texturePreview.dataset.url = textureUrl;
                    saveBtn.disabled = false;
                } catch (error) {
                    console.error('Error generating texture:', error);
                    alert('Failed to generate texture. Please try again.');
                } finally {
                    textureLoading.style.display = 'none';
                    generateBtn.disabled = false;
                }
            });
            
            saveBtn.addEventListener('click', async () => {
                if (!texturePreview.dataset.url) return;
                
                const textureName = document.getElementById('texture-prompt').value.trim();
                const textureUrl = texturePreview.dataset.url;
                
                // Add to custom textures array
                const newTexture = {
                    url: textureUrl,
                    name: textureName
                };
                
                this.customTextures.push(newTexture);
                
                // Add to swatches container
                const swatchesContainer = document.getElementById('colorSwatches');
                const newSwatch = this.addTextureToSwatches(newTexture, swatchesContainer);
                
                // Save to database
                try {
                    await this.saveCustomTexture(newTexture);
                    // Close modal and select the new texture
                    modal.style.display = 'none';
                    newSwatch.click();
                } catch (error) {
                    console.error('Error saving custom texture:', error);
                    alert('Failed to save the texture. Please try again.');
                }
            });
        }
        
        // Reset the modal state
        document.getElementById('texture-prompt').value = '';
        document.getElementById('texture-preview').style.display = 'none';
        document.getElementById('save-texture-btn').disabled = true;
        
        // Show the modal
        modal.style.display = 'block';
    }

    async saveCustomTexture(texture) {
        try {
            await this.room.collection('customTextures').create({
                url: texture.url,
                name: texture.name,
                timestamp: new Date().toISOString()
            });
            console.log('Custom texture saved to database');
        } catch (error) {
            console.error('Error saving custom texture:', error);
            throw error;
        }
    }

    async loadCustomTextures() {
        try {
            const textures = await this.room.collection('customTextures').getList();
            
            if (textures.length > 0) {
                console.log(`Found ${textures.length} custom textures`);
                
                // Store custom textures
                this.customTextures = textures.map(texture => ({
                    url: texture.url,
                    name: texture.name
                }));
                
                // Refresh the color palette to include the textures
                this.initializeColorPalette();
            }
            
            // Subscribe to future additions
            this.room.collection('customTextures').subscribe((textures) => {
                // Update our list of textures when new ones are added
                this.customTextures = textures.map(texture => ({
                    url: texture.url,
                    name: texture.name
                }));
                
                // Refresh the palette
                this.initializeColorPalette();
            });
        } catch (error) {
            console.error('Error loading custom textures:', error);
        }
    }

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

    applyColorBrush(hitPoint, brushRadius, brushStrength) {
        this.ensureColorAttribute();
        
        const positions = this.geometry.attributes.position;
        const colorAttribute = this.geometry.attributes.color;
        const vertex = new THREE.Vector3();
        let colorModified = false;

        // Check if current color is a texture URL - with safe error handling
        let isTextureUrl = false;
        try {
            isTextureUrl = this.textureHandler.isTextureUrl(this.currentColor);
        } catch (err) {
            console.warn("Error checking texture URL:", err);
        }
        
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
                
                if (isTextureUrl) {
                    // Store texture URL directly for database
                    this.colorChanges[i] = this.currentColor;
                    
                    // For rendering, just set a representative color for now
                    // (actual texture will be applied by shader or material)
                    const tempColor = new THREE.Color(0x888888); // Gray to represent texture
                    colorAttribute.setXYZ(i, tempColor.r, tempColor.g, tempColor.b);
                } else {
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
                }
                
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

    async loadColorData() {
        try {
            // Load custom textures first
            await this.loadCustomTextures();
            
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