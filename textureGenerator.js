import * as THREE from 'three';

export class TextureGenerator {
    constructor(colorManager) {
        this.colorManager = colorManager;
        this.generating = false;
        this.setupUI();
    }

    async initialize() {
        // Check if websim.imageGen is available
        if (!window.websim || !window.websim.imageGen) {
            console.warn('AI image generation not available in this environment');
        }
    }

    setupUI() {
        // Add a texture generator section to the controls
        const controls = document.getElementById('controls');
        
        const textureGenSection = document.createElement('div');
        textureGenSection.className = 'control-group';
        textureGenSection.id = 'textureGeneratorControl';
        textureGenSection.innerHTML = `
            <label>Generate Texture:</label>
            <input type="text" id="texturePrompt" placeholder="Describe terrain texture..." class="texture-input">
            <div class="button-group">
                <button id="generateTextureBtn">
                    <svg class="tool-icon" viewBox="0 0 24 24">
                        <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                    </svg>
                    Generate
                </button>
            </div>
            <div id="texturePreview" style="display: none; margin-top: 10px;">
                <p id="textureStatus">Generating texture...</p>
                <img id="textureImage" style="width: 100%; border-radius: 4px; display: none;">
                <div class="button-group" style="margin-top: 5px;">
                    <button id="applyTextureBtn" style="display: none;">Apply Texture</button>
                    <button id="cancelTextureBtn" style="display: none;">Cancel</button>
                </div>
            </div>
        `;
        
        controls.appendChild(textureGenSection);
        
        // Add CSS for the texture generator
        const style = document.createElement('style');
        style.textContent = `
            .texture-input {
                width: 100%;
                padding: 8px;
                border-radius: 4px;
                border: 1px solid #555;
                background-color: #333;
                color: white;
                margin-bottom: 5px;
            }
            #texturePreview {
                background-color: rgba(0,0,0,0.3);
                padding: 8px;
                border-radius: 4px;
            }
            #textureStatus {
                font-size: 0.8em;
                margin: 0 0 5px 0;
            }
            .spinner {
                border: 3px solid rgba(255,255,255,0.3);
                border-radius: 50%;
                border-top: 3px solid white;
                width: 20px;
                height: 20px;
                animation: spin 1s linear infinite;
                margin: 10px auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
        
        // Add event listeners
        document.getElementById('generateTextureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.generateTexture();
        });
        
        document.getElementById('applyTextureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.applyGeneratedTexture();
        });
        
        document.getElementById('cancelTextureBtn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.cancelTexturePreview();
        });
        
        // Allow generating with Enter key
        document.getElementById('texturePrompt').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.generateTexture();
            }
        });
    }
    
    async generateTexture() {
        const promptInput = document.getElementById('texturePrompt');
        const prompt = promptInput.value.trim();
        
        if (!prompt) {
            alert('Please enter a texture description');
            return;
        }
        
        if (this.generating) {
            alert('Already generating a texture, please wait');
            return;
        }
        
        if (!window.websim || !window.websim.imageGen) {
            alert('AI image generation is not available in this environment');
            return;
        }
        
        // Show preview panel with loading state
        const previewPanel = document.getElementById('texturePreview');
        const statusText = document.getElementById('textureStatus');
        const textureImage = document.getElementById('textureImage');
        const applyBtn = document.getElementById('applyTextureBtn');
        const cancelBtn = document.getElementById('cancelTextureBtn');
        
        previewPanel.style.display = 'block';
        statusText.textContent = 'Generating texture...';
        
        // Add a spinner
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        previewPanel.insertBefore(spinner, textureImage);
        
        textureImage.style.display = 'none';
        applyBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-block';
        
        this.generating = true;
        
        try {
            // Enhance the prompt to focus on terrain textures
            const enhancedPrompt = `A seamless terrain texture for: ${prompt}. High quality, top-down view, tileable pattern for 3D terrain.`;
            
            // Generate the image
            const result = await window.websim.imageGen({
                prompt: enhancedPrompt,
                aspect_ratio: "1:1",
            });
            
            // Display the generated texture
            if (result && result.url) {
                // Remove spinner
                if (spinner) spinner.remove();
                
                textureImage.src = result.url;
                textureImage.style.display = 'block';
                textureImage.dataset.prompt = prompt;
                statusText.textContent = 'Texture generated! Apply to use as a paint brush.';
                applyBtn.style.display = 'inline-block';
                
                this.generatedTextureUrl = result.url;
            } else {
                throw new Error('Failed to generate texture image');
            }
        } catch (error) {
            console.error('Error generating texture:', error);
            statusText.textContent = 'Error generating texture: ' + error.message;
            if (spinner) spinner.remove();
        } finally {
            this.generating = false;
        }
    }
    
    applyGeneratedTexture() {
        if (!this.generatedTextureUrl) return;
        
        const promptInput = document.getElementById('texturePrompt');
        const textureName = promptInput.value.trim() || 'Custom Texture';
        
        // Add the texture to the color manager
        this.colorManager.applyTextureAsColor(this.generatedTextureUrl, textureName);
        
        // Switch to paint tool
        const colorBtn = document.getElementById('colorBtn');
        if (colorBtn) {
            colorBtn.click();
        }
        
        // Hide preview panel
        this.cancelTexturePreview();
        
        // Preload the texture for immediate use
        if (this.colorManager.textureCache && this.generatedTextureUrl) {
            const textureId = 'texture-' + Date.now();
            const texture = new THREE.TextureLoader().load(this.generatedTextureUrl);
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            this.colorManager.textureCache[textureId] = texture;
        }
        
        // Show confirmation
        const statusElement = document.getElementById('save-status');
        if (statusElement) {
            statusElement.textContent = 'Texture applied as paint brush!';
            statusElement.style.opacity = '1';
            statusElement.style.backgroundColor = 'rgba(40,167,69,0.7)';
            setTimeout(() => {
                statusElement.style.opacity = '0';
            }, 1500);
        }
    }
    
    cancelTexturePreview() {
        const previewPanel = document.getElementById('texturePreview');
        const textureImage = document.getElementById('textureImage');
        
        previewPanel.style.display = 'none';
        textureImage.src = '';
        this.generatedTextureUrl = null;
        
        // Remove any spinners
        const spinner = document.querySelector('.spinner');
        if (spinner) spinner.remove();
    }
}