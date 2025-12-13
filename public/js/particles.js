// Particle System for Background Animation
class ParticleSystem {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.particles = [];
        this.particleCount = 50;
        this.connectionDistance = 150;
        this.mouse = { x: null, y: null, radius: 200 };
        
        this.init();
    }
    
    init() {
        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'particles-canvas';
        this.canvas.style.position = 'fixed';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.zIndex = '-1';
        this.canvas.style.pointerEvents = 'none';
        document.body.appendChild(this.canvas);
        
        this.ctx = this.canvas.getContext('2d');
        // Detect whether the 2D context supports createRadialGradient in this environment
        this.supportsRadial = !!(this.ctx && typeof this.ctx.createRadialGradient === 'function');
        this.setCanvasSize();
        this.createParticles();
        
        // Event listeners
        window.addEventListener('resize', () => this.setCanvasSize());
        window.addEventListener('mousemove', (e) => {
            this.mouse.x = e.x;
            this.mouse.y = e.y;
        });
        
        window.addEventListener('mouseout', () => {
            this.mouse.x = null;
            this.mouse.y = null;
        });
        
        this.animate();
    }
    
    setCanvasSize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    createParticles() {
        this.particles = [];
        for (let i = 0; i < this.particleCount; i++) {
            this.particles.push(new Particle(
                Math.random() * this.canvas.width,
                Math.random() * this.canvas.height,
                Math.random() * 2 - 1,
                Math.random() * 2 - 1,
                Math.random() * 2 + 1
            ));
        }
    }
    
    animate() {
        try {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // Update and draw particles
            this.particles.forEach(particle => {
                try {
                    particle.update(this.canvas.width, this.canvas.height, this.mouse);
                    particle.draw(this.ctx);
                } catch (e) {
                    console.warn('[Particles] particle draw/update error:', e);
                }
            });
        } catch (e) {
            console.warn('[Particles] animate loop error:', e);
        }
        
        // Draw connections
        this.drawConnections();
        
        requestAnimationFrame(() => this.animate());
    }
    
    drawConnections() {
        try {
            for (let i = 0; i < this.particles.length; i++) {
                for (let j = i + 1; j < this.particles.length; j++) {
                    const dx = this.particles[i].x - this.particles[j].x;
                    const dy = this.particles[i].y - this.particles[j].y;
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance < this.connectionDistance) {
                        const opacity = 1 - (distance / this.connectionDistance);

                        // Use theme-aware colors
                        const isDarkMode = document.documentElement.classList.contains('dark-mode');
                        const color = isDarkMode ? '166, 161, 182' : '102, 126, 234';

                        this.ctx.strokeStyle = `rgba(${color}, ${opacity * 0.3})`;
                        this.ctx.lineWidth = 1;
                        this.ctx.beginPath();
                        this.ctx.moveTo(this.particles[i].x, this.particles[i].y);
                        this.ctx.lineTo(this.particles[j].x, this.particles[j].y);
                        this.ctx.stroke();
                    }
                }
            }
        } catch (e) {
            console.warn('[Particles] drawConnections error:', e);
        }
    }
}

class Particle {
    constructor(x, y, vx, vy, radius) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.radius = radius;
        this.baseX = x;
        this.baseY = y;
    }
    
    update(width, height, mouse) {
        // Boundary check
        if (this.x > width || this.x < 0) {
            this.vx = -this.vx;
        }
        if (this.y > height || this.y < 0) {
            this.vy = -this.vy;
        }
        
        // Move particle
        this.x += this.vx;
        this.y += this.vy;
        
        // Mouse interaction
        if (mouse.x !== null && mouse.y !== null) {
            const dx = mouse.x - this.x;
            const dy = mouse.y - this.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < mouse.radius) {
                const forceDirectionX = dx / distance;
                const forceDirectionY = dy / distance;
                const force = (mouse.radius - distance) / mouse.radius;
                const directionX = forceDirectionX * force * 3;
                const directionY = forceDirectionY * force * 3;
                
                this.x -= directionX;
                this.y -= directionY;
            }
        }
        
        // Return to base position
        const dx = this.baseX - this.x;
        const dy = this.baseY - this.y;
        this.x += dx * 0.05;
        this.y += dy * 0.05;
    }
    
    draw(ctx) {
        // Use theme-aware colors
        const isDarkMode = document.documentElement.classList.contains('dark-mode');
        // Validate inputs and ctx
        if (!ctx || !isFinite(this.x) || !isFinite(this.y) || !isFinite(this.radius) || this.radius <= 0) {
            return;
        }

        let paintedWithGradient = false;
        if (ctx && typeof ctx.createRadialGradient === 'function') {
            try {
                const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius);
                if (isDarkMode) {
                    gradient.addColorStop(0, 'rgba(102, 126, 234, 0.8)');
                    gradient.addColorStop(1, 'rgba(102, 126, 234, 0)');
                } else {
                    gradient.addColorStop(0, 'rgba(102, 126, 234, 0.6)');
                    gradient.addColorStop(1, 'rgba(102, 126, 234, 0)');
                }
                ctx.fillStyle = gradient;
                paintedWithGradient = true;
            } catch (e) {
                // Some browsers/environment can throw NotSupportedError — we'll fall back below
                paintedWithGradient = false;
            }
        }

        if (paintedWithGradient) {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        // Fallback: draw a simple solid circle with optional glow using shadow if available
        try {
            ctx.save();
            // Slightly stronger color when dark mode
            const fillColor = isDarkMode ? 'rgba(102, 126, 234, 0.7)' : 'rgba(102, 126, 234, 0.6)';
            // Attempt to provide a soft glow without gradients
            if (typeof ctx.shadowBlur === 'number') {
                ctx.shadowColor = fillColor;
                ctx.shadowBlur = Math.max(0, Math.min(20, this.radius * 0.75));
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = fillColor;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        } catch (e) {
            // If anything fails here, silently ignore to avoid breaking the whole animation
            return;
        }
    }
}

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new ParticleSystem();
    });
} else {
    new ParticleSystem();
}
