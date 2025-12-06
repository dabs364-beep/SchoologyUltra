// Grades page functionality

// Store original grades and custom assignments
const originalGrades = {};
const modifiedGrades = {};
const customAssignments = {};
let customIdCounter = 1;

document.addEventListener('DOMContentLoaded', () => {
    // Store all original grades
    document.querySelectorAll('.grade-input').forEach(input => {
        const sectionId = input.dataset.section;
        const original = parseFloat(input.dataset.original);
        
        if (!originalGrades[sectionId]) {
            originalGrades[sectionId] = {};
        }
        
        const key = input.closest('tr').dataset.assignment;
        originalGrades[sectionId][key] = original;
    });
    
    // Load saved data from cookies
    loadModifiedGrades();
    loadCustomAssignments();
});

// Toggle course grades visibility
function toggleCourse(index) {
    try {
        const container = document.getElementById('course-' + index);
        if (!container) {
            console.error('toggleCourse: Could not find course-' + index);
            return;
        }
        const header = container.previousElementSibling;
        
        if (container.style.display === 'none') {
            container.style.display = 'block';
            if (header) header.classList.add('open');
        } else {
            container.style.display = 'none';
            if (header) header.classList.remove('open');
        }
    } catch (e) {
        console.error('toggleCourse error:', e);
    }
}

// Get grade color class based on percentage
function getGradeColorClass(percentage) {
    if (percentage >= 90) return 'grade-a';
    if (percentage >= 80) return 'grade-b';
    if (percentage >= 70) return 'grade-c';
    if (percentage >= 60) return 'grade-d';
    return 'grade-f';
}

// Update grade and recalculate
function updateGrade(input) {
    const sectionId = input.dataset.section;
    const row = input.closest('tr');
    const maxInput = row.querySelector('.max-input');
    const maxPoints = parseFloat(maxInput.value) || 100;
    const newGrade = parseFloat(input.value);
    const originalGrade = parseFloat(input.dataset.original);
    
    // Validate input
    if (isNaN(newGrade)) {
        input.value = originalGrade;
        return;
    }
    
    // Mark as modified if different from original (using small epsilon for float comparison)
    const isDifferent = Math.abs(newGrade - originalGrade) > 0.001;
    
    if (isDifferent) {
        input.classList.add('modified');
        
        if (!modifiedGrades[sectionId]) {
            modifiedGrades[sectionId] = {};
        }
        const key = row.dataset.assignment;
        if (!modifiedGrades[sectionId][key]) {
            modifiedGrades[sectionId][key] = {};
        }
        modifiedGrades[sectionId][key].grade = newGrade;
    } else {
        input.classList.remove('modified');
        
        const key = row.dataset.assignment;
        if (modifiedGrades[sectionId] && modifiedGrades[sectionId][key]) {
            delete modifiedGrades[sectionId][key].grade;
            if (Object.keys(modifiedGrades[sectionId][key]).length === 0) {
                delete modifiedGrades[sectionId][key];
            }
        }
    }
    
    // Update percentage in the same row
    const percentCell = row.querySelector('.percentage');
    if (percentCell && maxPoints > 0) {
        const pct = (newGrade / maxPoints) * 100;
        percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
    }
    
    // Recalculate category and course grades
    recalculateAllGrades(sectionId);
    
    saveModifiedGrades();
}

// Update max points and recalculate
function updateMaxPoints(input) {
    const sectionId = input.dataset.section;
    const row = input.closest('tr');
    const gradeInput = row.querySelector('.grade-input');
    const newMax = parseFloat(input.value) || 100;
    const originalMax = parseFloat(input.dataset.original);
    
    // Validate input
    if (isNaN(newMax) || newMax <= 0) {
        input.value = originalMax;
        return;
    }
    
    // Mark as modified if different from original (using small epsilon for float comparison)
    const isDifferent = Math.abs(newMax - originalMax) > 0.001;
    
    if (isDifferent) {
        input.classList.add('modified');
        
        if (!modifiedGrades[sectionId]) {
            modifiedGrades[sectionId] = {};
        }
        const key = row.dataset.assignment;
        if (!modifiedGrades[sectionId][key]) {
            modifiedGrades[sectionId][key] = {};
        }
        modifiedGrades[sectionId][key].max = newMax;
    } else {
        input.classList.remove('modified');
        
        const key = row.dataset.assignment;
        if (modifiedGrades[sectionId] && modifiedGrades[sectionId][key]) {
            delete modifiedGrades[sectionId][key].max;
            if (Object.keys(modifiedGrades[sectionId][key]).length === 0) {
                delete modifiedGrades[sectionId][key];
            }
        }
    }
    
    // Update percentage in the same row if there's a grade
    if (gradeInput) {
        const grade = parseFloat(gradeInput.value);
        if (!isNaN(grade) && newMax > 0) {
            const percentCell = row.querySelector('.percentage');
            const pct = (grade / newMax) * 100;
            if (percentCell) {
                percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
            }
        }
    }
    
    recalculateAllGrades(sectionId);
    saveModifiedGrades();
}

// Add custom assignment to a category
function addCustomAssignment(sectionId, catIndex) {
    const nameInput = document.getElementById('custom-name-' + sectionId + '-' + catIndex);
    const scoreInput = document.getElementById('custom-score-' + sectionId + '-' + catIndex);
    const maxInput = document.getElementById('custom-max-' + sectionId + '-' + catIndex);
    
    const name = nameInput.value.trim() || 'Custom Assignment';
    const score = parseFloat(scoreInput.value);
    const max = parseFloat(maxInput.value) || 100;
    
    if (isNaN(score)) {
        showToast('Please enter a score', 'error');
        return;
    }
    
    if (score < 0 || max <= 0) {
        showToast('Please enter valid values', 'error');
        return;
    }
    
    // Create custom assignment
    const customId = 'custom-' + (customIdCounter++);
    const assignment = {
        id: customId,
        name: name,
        score: score,
        max: max,
        sectionId: sectionId,
        catIndex: catIndex
    };
    
    // Store custom assignment
    if (!customAssignments[sectionId]) {
        customAssignments[sectionId] = {};
    }
    if (!customAssignments[sectionId][catIndex]) {
        customAssignments[sectionId][catIndex] = [];
    }
    customAssignments[sectionId][catIndex].push(assignment);
    
    // Add row to table
    addCustomAssignmentRow(assignment);
    
    // Clear inputs
    nameInput.value = '';
    scoreInput.value = '';
    maxInput.value = '100';
    
    // Recalculate grades
    recalculateAllGrades(sectionId);
    
    // Save to cookie
    saveCustomAssignments();
    
    showToast('Added "' + name + '"', 'success');
}

// Add custom assignment row to table
function addCustomAssignmentRow(assignment) {
    const tbody = document.getElementById('cat-tbody-' + assignment.sectionId + '-' + assignment.catIndex);
    if (!tbody) return;
    
    const pct = (assignment.score / assignment.max) * 100;
    
    const row = document.createElement('tr');
    row.className = 'grade-row custom-assignment-row';
    row.dataset.section = assignment.sectionId;
    row.dataset.assignment = assignment.id;
    row.dataset.custom = 'true';
    
    row.innerHTML = 
        '<td class="assignment-name">' + assignment.name + '<span class="custom-badge">Custom</span></td>' +
        '<td class="due-date">-</td>' +
        '<td class="grade-value">' +
            '<input type="number" class="grade-input" value="' + assignment.score + '" ' +
                'data-original="' + assignment.score + '" data-section="' + assignment.sectionId + '" ' +
                'onchange="updateCustomGrade(this, \'' + assignment.id + '\')" step="0.5">' +
        '</td>' +
        '<td class="max-points">' +
            '<input type="number" class="max-input" value="' + assignment.max + '" ' +
                'data-original="' + assignment.max + '" data-section="' + assignment.sectionId + '" ' +
                'onchange="updateCustomMax(this, \'' + assignment.id + '\')" step="0.5">' +
        '</td>' +
        '<td class="percentage">' +
            '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>' +
            '<button class="remove-custom" onclick="removeCustomAssignment(\'' + assignment.sectionId + '\', ' + assignment.catIndex + ', \'' + assignment.id + '\')" title="Remove">×</button>' +
        '</td>';
    
    tbody.appendChild(row);
}

// Update custom assignment grade
function updateCustomGrade(input, customId) {
    const sectionId = input.dataset.section;
    const row = input.closest('tr');
    const catIndex = parseInt(row.closest('tbody').dataset.catIndex);
    const newScore = parseFloat(input.value);
    
    // Update stored assignment
    if (customAssignments[sectionId] && customAssignments[sectionId][catIndex]) {
        const assignment = customAssignments[sectionId][catIndex].find(a => a.id === customId);
        if (assignment) {
            assignment.score = newScore;
        }
    }
    
    // Update percentage
    const maxInput = row.querySelector('.max-input');
    const max = parseFloat(maxInput.value) || 100;
    const pct = (newScore / max) * 100;
    const percentCell = row.querySelector('.percentage');
    const removeBtn = percentCell.querySelector('.remove-custom');
    percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
    percentCell.appendChild(removeBtn);
    
    recalculateAllGrades(sectionId);
    saveCustomAssignments();
}

// Update custom assignment max
function updateCustomMax(input, customId) {
    const sectionId = input.dataset.section;
    const row = input.closest('tr');
    const catIndex = parseInt(row.closest('tbody').dataset.catIndex);
    const newMax = parseFloat(input.value) || 100;
    
    // Update stored assignment
    if (customAssignments[sectionId] && customAssignments[sectionId][catIndex]) {
        const assignment = customAssignments[sectionId][catIndex].find(a => a.id === customId);
        if (assignment) {
            assignment.max = newMax;
        }
    }
    
    // Update percentage
    const gradeInput = row.querySelector('.grade-input');
    const score = parseFloat(gradeInput.value) || 0;
    const pct = (score / newMax) * 100;
    const percentCell = row.querySelector('.percentage');
    const removeBtn = percentCell.querySelector('.remove-custom');
    percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
    percentCell.appendChild(removeBtn);
    
    recalculateAllGrades(sectionId);
    saveCustomAssignments();
}

// Remove custom assignment
function removeCustomAssignment(sectionId, catIndex, customId) {
    // Remove from storage
    if (customAssignments[sectionId] && customAssignments[sectionId][catIndex]) {
        customAssignments[sectionId][catIndex] = customAssignments[sectionId][catIndex].filter(a => a.id !== customId);
    }
    
    // Remove row from DOM
    const row = document.querySelector('tr[data-assignment="' + customId + '"]');
    if (row) {
        row.remove();
    }
    
    recalculateAllGrades(sectionId);
    saveCustomAssignments();
    
    showToast('Removed custom assignment', 'success');
}

// Recalculate all grades for a section
function recalculateAllGrades(sectionId) {
    const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (!courseCard) return;
    
    let totalSectionEarned = 0;
    let totalSectionMax = 0;
    let hasChanges = false;
    
    // Process each category
    courseCard.querySelectorAll('.category-section').forEach(catSection => {
        const catIndex = catSection.dataset.category;
        const catGradeDiv = catSection.querySelector('.category-grade');
        const originalCatPct = parseFloat(catGradeDiv?.dataset.originalPct) || null;
        
        let catEarned = 0;
        let catMax = 0;
        
        // Sum all grades in this category (including custom)
        catSection.querySelectorAll('.grade-row').forEach(row => {
            const gradeInput = row.querySelector('.grade-input');
            const maxInput = row.querySelector('.max-input');
            
            if (gradeInput && maxInput) {
                const grade = parseFloat(gradeInput.value) || 0;
                const max = parseFloat(maxInput.value) || 0;
                
                catEarned += grade;
                catMax += max;
                
                // Check if modified
                const originalGrade = parseFloat(gradeInput.dataset.original);
                const originalMax = parseFloat(maxInput.dataset.original);
                if (grade !== originalGrade || max !== originalMax || row.dataset.custom === 'true') {
                    hasChanges = true;
                }
            }
        });
        
        totalSectionEarned += catEarned;
        totalSectionMax += catMax;
        
        // Update category grade display
        const newCatPct = catMax > 0 ? (catEarned / catMax * 100) : 0;
        const catEditedEl = document.getElementById('cat-edited-' + sectionId + '-' + catIndex);
        
        if (catEditedEl && originalCatPct !== null) {
            if (Math.abs(newCatPct - originalCatPct) > 0.01 || (customAssignments[sectionId] && customAssignments[sectionId][catIndex]?.length > 0)) {
                catEditedEl.style.display = 'inline';
                catEditedEl.querySelector('.edited-val').innerHTML = '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + newCatPct.toFixed(1) + '% (' + getLetterGrade(newCatPct) + ')</span>';
            } else {
                catEditedEl.style.display = 'none';
            }
        }
    });
    
    // Update section totals
    document.getElementById('earned-' + sectionId).textContent = totalSectionEarned.toFixed(1);
    document.getElementById('total-' + sectionId).textContent = totalSectionMax.toFixed(1);
    
    // Update section grade display
    const newSectionPct = totalSectionMax > 0 ? (totalSectionEarned / totalSectionMax * 100) : 0;
    const editedSectionEl = document.getElementById('edited-section-' + sectionId);
    const originalGradeEl = courseCard.querySelector('.original-grade');
    const originalPctStr = originalGradeEl?.dataset.originalPct;
    const hasOriginalGrade = originalPctStr !== '' && originalPctStr !== undefined && originalPctStr !== null;
    const originalSectionPct = hasOriginalGrade ? parseFloat(originalPctStr) : null;
    
    if (editedSectionEl) {
        // Show calculated grade if:
        // 1. There are changes AND the calculated grade differs from original, OR
        // 2. There was no original API grade but now we have grades to calculate
        const shouldShowCalculated = hasChanges && (
            (hasOriginalGrade && Math.abs(newSectionPct - originalSectionPct) > 0.01) ||
            (!hasOriginalGrade && totalSectionMax > 0)
        );
        
        if (shouldShowCalculated) {
            editedSectionEl.style.display = 'flex';
            document.getElementById('edited-pct-' + sectionId).className = 'grade-pill ' + getGradeColorClass(newSectionPct);
            document.getElementById('edited-pct-' + sectionId).textContent = newSectionPct.toFixed(1) + '%';
            document.getElementById('edited-letter-' + sectionId).className = 'grade-pill ' + getGradeColorClass(newSectionPct);
            document.getElementById('edited-letter-' + sectionId).textContent = getLetterGrade(newSectionPct);
        } else {
            editedSectionEl.style.display = 'none';
        }
    }
}

// Save/Load functions
function saveModifiedGrades() {
    setCookie('modifiedGrades', modifiedGrades);
}

function loadModifiedGrades() {
    const saved = getCookie('modifiedGrades');
    
    if (saved) {
        Object.assign(modifiedGrades, saved);
        
        Object.keys(modifiedGrades).forEach(sectionId => {
            Object.keys(modifiedGrades[sectionId]).forEach(assignmentId => {
                const row = document.querySelector('tr[data-section="' + sectionId + '"][data-assignment="' + assignmentId + '"]');
                if (row) {
                    const mods = modifiedGrades[sectionId][assignmentId];
                    const gradeInput = row.querySelector('.grade-input');
                    const maxInput = row.querySelector('.max-input');
                    
                    if (mods.grade !== undefined && gradeInput) {
                        gradeInput.value = mods.grade;
                        gradeInput.classList.add('modified');
                    }
                    
                    if (mods.max !== undefined && maxInput) {
                        maxInput.value = mods.max;
                        maxInput.classList.add('modified');
                    }
                    
                    // Update percentage display
                    if (gradeInput && maxInput) {
                        const grade = parseFloat(gradeInput.value);
                        const max = parseFloat(maxInput.value);
                        if (!isNaN(grade) && !isNaN(max) && max > 0) {
                            const pct = (grade / max) * 100;
                            const percentCell = row.querySelector('.percentage');
                            if (percentCell) {
                                percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
                            }
                        }
                    }
                }
            });
            
            recalculateAllGrades(sectionId);
        });
    }
}

function saveCustomAssignments() {
    setCookie('customAssignments', customAssignments);
}

function loadCustomAssignments() {
    const saved = getCookie('customAssignments');
    
    if (saved) {
        Object.assign(customAssignments, saved);
        
        // Recreate custom assignment rows
        Object.keys(customAssignments).forEach(sectionId => {
            Object.keys(customAssignments[sectionId]).forEach(catIndex => {
                customAssignments[sectionId][catIndex].forEach(assignment => {
                    addCustomAssignmentRow(assignment);
                });
            });
            
            recalculateAllGrades(sectionId);
        });
    }
}

// Reset all changes
function resetAllChanges() {
    if (!confirm('Are you sure you want to reset all grade changes and remove custom assignments?')) {
        return;
    }
    
    // Reset all grade inputs to original values
    document.querySelectorAll('.grade-input').forEach(input => {
        const original = parseFloat(input.dataset.original);
        input.value = original;
        input.classList.remove('modified');
    });
    
    // Reset all max inputs to original values
    document.querySelectorAll('.max-input').forEach(input => {
        const original = parseFloat(input.dataset.original);
        input.value = original;
        input.classList.remove('modified');
    });
    
    // Update all percentages
    document.querySelectorAll('.grade-row:not(.custom-assignment-row)').forEach(row => {
        const gradeInput = row.querySelector('.grade-input');
        const maxInput = row.querySelector('.max-input');
        if (gradeInput && maxInput) {
            const grade = parseFloat(gradeInput.value);
            const max = parseFloat(maxInput.value);
            const pct = (grade / max) * 100;
            const percentCell = row.querySelector('.percentage');
            percentCell.innerHTML = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(1) + '%</span>';
        }
    });
    
    // Remove custom assignment rows
    document.querySelectorAll('.custom-assignment-row').forEach(row => {
        row.remove();
    });
    
    // Clear storage
    Object.keys(modifiedGrades).forEach(key => delete modifiedGrades[key]);
    Object.keys(customAssignments).forEach(key => delete customAssignments[key]);
    
    // Recalculate and hide edited displays
    document.querySelectorAll('.course-card').forEach(card => {
        const sectionId = card.dataset.section;
        recalculateAllGrades(sectionId);
        
        // Hide edited displays
        const editedSection = document.getElementById('edited-section-' + sectionId);
        if (editedSection) editedSection.style.display = 'none';
        
        card.querySelectorAll('.category-edited').forEach(el => {
            el.style.display = 'none';
        });
    });
    
    // Clear cookies
    deleteCookie('modifiedGrades');
    deleteCookie('customAssignments');
    
    showToast('All changes have been reset', 'success');
}
