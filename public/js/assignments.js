// Assignments page functionality

function initAssignmentsPage() {
    try {
        loadCompletedAssignments();
        loadCustomAssignments();
    } catch (e) {
        console.warn('initAssignmentsPage failed:', e);
    }
}

// Load completed assignments from cookies
document.addEventListener('DOMContentLoaded', initAssignmentsPage);
window.addEventListener('spa:load', initAssignmentsPage);

// Get completed assignments from cookie
function getCompletedAssignments() {
    return getCookie('completedAssignments') || [];
}

// Save completed assignments to cookie
function saveCompletedAssignments(completed) {
    setCookie('completedAssignments', completed);
}

// Load and apply completed status to assignments
function loadCompletedAssignments() {
    const completed = getCompletedAssignments();
    
    completed.forEach(id => {
        const card = document.querySelector(`.assignment-card[data-id="${id}"]`);
        if (card) {
            card.classList.add('completed');
            const checkbox = card.querySelector('.complete-checkbox');
            if (checkbox) {
                checkbox.checked = true;
            }
        }
    });
}

// Toggle assignment completion
function toggleComplete(assignmentId) {
    const card = document.querySelector(`.assignment-card[data-id="${assignmentId}"]`);
    const checkbox = document.getElementById(`check-${assignmentId}`);
    let completed = getCompletedAssignments();
    
    if (checkbox.checked) {
        card.classList.add('completed');
        if (!completed.includes(assignmentId)) {
            completed.push(assignmentId);
        }
        showToast('Assignment marked as completed! ✓', 'success');
    } else {
        card.classList.remove('completed');
        completed = completed.filter(id => id !== assignmentId);
        showToast('Assignment marked as incomplete', 'info');
    }
    
    saveCompletedAssignments(completed);
    filterAssignments();
}

// Get custom assignments from cookie
function getCustomAssignments() {
    return getCookie('customAssignments') || [];
}

// Save custom assignments to cookie
function saveCustomAssignments(assignments) {
    setCookie('customAssignments', assignments);
}

// Load and display custom assignments
function loadCustomAssignments() {
    const customAssignments = getCustomAssignments();
    const container = document.getElementById('customAssignments');

    // If the container is not present (SPA body swap timing or different page), bail out safely
    if (!container) {
        return;
    }

    if (customAssignments.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    // Sort by due date
    customAssignments.sort((a, b) => {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return new Date(a.due) - new Date(b.due);
    });
    
    const completed = getCompletedAssignments();
    
    let html = '<h2 style="margin: 30px 0 15px; color: var(--dark);">📌 Custom Assignments</h2>';
    
    customAssignments.forEach(assignment => {
        const isCompleted = completed.includes(`custom-${assignment.id}`);
        const isOverdue = assignment.due && new Date(assignment.due) < new Date();
        
        html += `
            <div class="assignment-card custom ${isCompleted ? 'completed' : ''}" 
                 data-id="custom-${assignment.id}" 
                 data-section="custom"
                 data-type="custom">
                <div class="assignment-check">
                    <input type="checkbox" 
                           class="complete-checkbox" 
                           id="check-custom-${assignment.id}"
                           ${isCompleted ? 'checked' : ''}
                           onchange="toggleComplete('custom-${assignment.id}')">
                </div>
                <div class="assignment-content">
                    <h3 class="assignment-title">${escapeHtml(assignment.title)}</h3>
                    <p class="assignment-course">${escapeHtml(assignment.course || 'Custom Assignment')}</p>
                    ${assignment.description ? `<p class="assignment-desc">${escapeHtml(assignment.description)}</p>` : ''}
                </div>
                <div class="assignment-meta">
                    ${assignment.due ? `
                        <span class="due-date ${isOverdue ? 'overdue' : ''}">
                            📅 ${new Date(assignment.due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                    ` : '<span class="due-date no-due">No due date</span>'}
                    <button class="delete-btn" onclick="deleteCustomAssignment('${assignment.id}')" 
                            style="background: none; border: none; color: #dc3545; cursor: pointer; font-size: 0.9rem;">
                        🗑️ Delete
                    </button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

// Show add assignment modal
function showAddModal() {
    const modal = document.getElementById('addModal');
    if (!modal) return;
    modal.classList.add('show');
}

// Close modal
function closeModal() {
    const modal = document.getElementById('addModal');
    const form = document.getElementById('addAssignmentForm');
    if (modal) modal.classList.remove('show');
    if (form) form.reset();
}

// Close modal when clicking outside (guard element existence)
const _addModalEl = document.getElementById('addModal');
if (_addModalEl) {
    _addModalEl.addEventListener('click', (e) => {
        if (e.target.id === 'addModal') {
            closeModal();
        }
    });
}

// Add custom assignment
function addCustomAssignment(event) {
    event.preventDefault();
    
    const title = document.getElementById('customTitle').value.trim();
    const course = document.getElementById('customCourse').value.trim();
    const due = document.getElementById('customDue').value;
    const description = document.getElementById('customDesc').value.trim();
    
    if (!title) {
        showToast('Please enter a title', 'error');
        return;
    }
    
    const customAssignments = getCustomAssignments();
    const newAssignment = {
        id: Date.now().toString(),
        title,
        course,
        due: due || null,
        description,
        createdAt: new Date().toISOString()
    };
    
    customAssignments.push(newAssignment);
    saveCustomAssignments(customAssignments);
    
    closeModal();
    loadCustomAssignments();
    showToast('Custom assignment added! 📝', 'success');
}

// Delete custom assignment
function deleteCustomAssignment(id) {
    if (!confirm('Are you sure you want to delete this assignment?')) {
        return;
    }
    
    let customAssignments = getCustomAssignments();
    customAssignments = customAssignments.filter(a => a.id !== id);
    saveCustomAssignments(customAssignments);
    
    // Also remove from completed
    let completed = getCompletedAssignments();
    completed = completed.filter(c => c !== `custom-${id}`);
    saveCompletedAssignments(completed);
    
    loadCustomAssignments();
    showToast('Assignment deleted', 'info');
}

// Filter assignments
function filterAssignments() {
    const courseFilter = document.getElementById('courseFilter').value;
    const hideCompleted = document.getElementById('hideCompleted').checked;
    const completed = getCompletedAssignments();
    
    const cards = document.querySelectorAll('.assignment-card');
    
    cards.forEach(card => {
        const sectionId = card.dataset.section;
        const assignmentId = card.dataset.id;
        const isCompleted = completed.includes(assignmentId);
        
        let show = true;
        
        // Course filter
        if (courseFilter !== 'all' && sectionId !== courseFilter && sectionId !== 'custom') {
            show = false;
        }
        
        // Hide completed filter
        if (hideCompleted && isCompleted) {
            show = false;
        }
        
        card.style.display = show ? '' : 'none';
    });
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
