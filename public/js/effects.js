// ============================================
// MODERN SPACE EFFECTS - Subtle & Clean
// ============================================

// Initialize subtle modern effects
document.addEventListener('DOMContentLoaded', function() {
    createShootingStars();
    addPlanetaryOrbs();
    createCosmicDust();
    console.log('✨ Modern space effects initialized');
});

// Create occasional shooting stars effect
function createShootingStars() {
    const count = 2;
    
    function createStar() {
        const star = document.createElement('div');
        star.className = 'shooting-star';
        star.style.top = Math.random() * 50 + '%';
        star.style.left = Math.random() * 100 + '%';
        star.style.animationDelay = Math.random() * 3 + 's';
        star.style.animationDuration = (Math.random() * 2 + 2) + 's';
        document.body.appendChild(star);
        
        setTimeout(() => {
            star.remove();
            if (Math.random() > 0.7) createStar();
        }, 6000);
    }
    
    for (let i = 0; i < count; i++) {
        setTimeout(() => createStar(), i * 3000);
    }
}

// Add subtle planetary orbs floating in background
function addPlanetaryOrbs() {
    const orbs = [
        { size: 200, color: 'rgba(91, 139, 245, 0.08)', x: 10, y: 20 },
        { size: 250, color: 'rgba(167, 139, 250, 0.06)', x: 80, y: 65 }
    ];
    
    orbs.forEach((orb, index) => {
        const el = document.createElement('div');
        el.className = 'planetary-orb';
        el.style.cssText = `
            position: fixed;
            width: ${orb.size}px;
            height: ${orb.size}px;
            background: radial-gradient(circle, ${orb.color}, transparent 70%);
            border-radius: 50%;
            left: ${orb.x}%;
            top: ${orb.y}%;
            pointer-events: none;
            z-index: -1;
            filter: blur(60px);
            animation: orbFloat ${20 + index * 5}s ease-in-out infinite;
        `;
        document.body.appendChild(el);
    });
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes orbFloat {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(20px, -30px) scale(1.05); }
        }
    `;
    if (!document.querySelector('style[data-orb-animation]')) {
        style.setAttribute('data-orb-animation', 'true');
        document.head.appendChild(style);
    }
}

// Create minimal cosmic dust particles
function createCosmicDust() {
    const dustContainer = document.createElement('div');
    dustContainer.className = 'cosmic-dust-container';
    dustContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 0;
    `;
    
    const particleCount = 20;
    for (let i = 0; i < particleCount; i++) {
        const dust = document.createElement('div');
        dust.className = 'dust-particle';
        dust.style.cssText = `
            position: absolute;
            width: ${Math.random() * 2 + 1}px;
            height: ${Math.random() * 2 + 1}px;
            background: rgba(255, 255, 255, ${Math.random() * 0.3 + 0.1});
            border-radius: 50%;
            top: ${Math.random() * 100}%;
            left: ${Math.random() * 100}%;
            animation: dustFloat ${Math.random() * 30 + 15}s linear infinite;
            animation-delay: ${Math.random() * 10}s;
        `;
        dustContainer.appendChild(dust);
    }
    
    document.body.appendChild(dustContainer);
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes dustFloat {
            0% { transform: translate(0, 0); opacity: 0; }
            10% { opacity: 1; }
            90% { opacity: 1; }
            100% { transform: translate(50px, -100vh); opacity: 0; }
        }
    `;
    if (!document.querySelector('style[data-dust-animation]')) {
        style.setAttribute('data-dust-animation', 'true');
        document.head.appendChild(style);
    }
}
