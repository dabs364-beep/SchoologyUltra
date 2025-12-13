// Grades page functionality

// Persisted edits/drops for official + custom rows
// Structure: { [sectionId]: { [assignmentId]: { grade?: number|null, max?: number|null, dropped?: boolean } } }
const gradeEdits = {};

// Custom assignments (kept compatible with existing cookie format)
const gradesCustomAssignments = {};
let customIdCounter = 1;

let activeEditRow = null;

function initGradesPage() {
    try {
        // Only run if the grades UI exists
        if (!document.querySelector('.grades-container')) return;
        // Cache server-original category header HTML before any JS modifies it
        cacheCategoryServerHtml();

        // Load saved data
        loadGradeEdits();
        loadCustomAssignments();

        // Apply edits/drops to existing official rows
        document.querySelectorAll('.grade-row[data-section][data-assignment]').forEach(row => {
            applyEditsToRow(row);
            updateRowComputedUI(row);
        });

        // Wire event handlers (delegated)
        bindGradesUiHandlers();

        // Recalculate all sections once
        document.querySelectorAll('.course-card[data-section]').forEach(card => {
            recalculateAllGrades(card.dataset.section);
        });
    } catch (e) {
        console.warn('initGradesPage failed:', e);
    }
}

// Cache the server-original HTML for category headers so we can restore
// the true "old" display later even after we update the visible primary value.
function cacheCategoryServerHtml() {
    try {
        document.querySelectorAll('.category-grade').forEach(el => {
            if (!el.dataset.serverOriginalHtml) {
                const primary = el.querySelector('.category-original');
                el.dataset.serverOriginalHtml = primary ? primary.innerHTML : '';
            }
        });
    } catch (e) {
        // non-fatal
    }
}

document.addEventListener('DOMContentLoaded', initGradesPage);
window.addEventListener('spa:load', initGradesPage);

function loadGradeEdits() {
    try {
        const saved = getCookie('gradeEdits');
        if (saved && typeof saved === 'object') {
            Object.keys(gradeEdits).forEach(k => delete gradeEdits[k]);
            Object.assign(gradeEdits, saved);
        }
    } catch (e) {
        console.warn('loadGradeEdits failed:', e);
    }
}

function saveGradeEdits() {
    try {
        setCookie('gradeEdits', gradeEdits);
    } catch (e) {
        console.warn('saveGradeEdits failed:', e);
    }
}

function getRowKey(row) {
    const sectionId = row.dataset.section;
    const assignmentId = row.dataset.assignment;
    return { sectionId, assignmentId };
}

function getRowNumbers(row) {
    const gradeRaw = row.dataset.currentGrade;
    const maxRaw = row.dataset.currentMax;
    const grade = (gradeRaw !== undefined && gradeRaw !== null && gradeRaw !== '') ? Number(gradeRaw) : null;
    const max = (maxRaw !== undefined && maxRaw !== null && maxRaw !== '') ? Number(maxRaw) : null;
    return {
        grade: (grade !== null && !isNaN(grade)) ? grade : null,
        max: (max !== null && !isNaN(max)) ? max : null
    };
}

function getRowOriginalNumbers(row) {
    const gradeRaw = row.dataset.originalGrade;
    const maxRaw = row.dataset.originalMax;
    const grade = (gradeRaw !== undefined && gradeRaw !== null && gradeRaw !== '') ? Number(gradeRaw) : null;
    const max = (maxRaw !== undefined && maxRaw !== null && maxRaw !== '') ? Number(maxRaw) : null;
    return {
        grade: (grade !== null && !isNaN(grade)) ? grade : null,
        max: (max !== null && !isNaN(max)) ? max : null
    };
}

function setRowDropped(row, dropped) {
    if (dropped) row.classList.add('dropped');
    else row.classList.remove('dropped');
}

function applyEditsToRow(row) {
    const { sectionId, assignmentId } = getRowKey(row);
    if (!sectionId || !assignmentId) return;
    const edits = gradeEdits?.[sectionId]?.[assignmentId];
    if (!edits) return;

    if (edits.grade !== undefined) row.dataset.currentGrade = (edits.grade === null ? '' : String(edits.grade));
    if (edits.max !== undefined) row.dataset.currentMax = (edits.max === null ? '' : String(edits.max));
    if (edits.dropped !== undefined) setRowDropped(row, !!edits.dropped);

    // Update grade display cell even if the original row showed 'Excused', 'Missing', or '-'
    const gradeCell = row.querySelector('.grade-value');
    const maxSpan = row.querySelector('.max-display');
    const currentGrade = row.dataset.currentGrade !== undefined ? row.dataset.currentGrade : '';
    if (gradeCell) {
        // prefer using .grade-display span when present; otherwise replace content
        const existingSpan = gradeCell.querySelector('.grade-display');
        if (existingSpan) {
            existingSpan.textContent = currentGrade === '' ? '-' : currentGrade;
        } else {
            gradeCell.innerHTML = currentGrade === '' ? '<span class="no-grade">-</span>' : '<span class="grade-display">' + currentGrade + '</span>';
        }
    }
    if (maxSpan && row.dataset.currentMax !== undefined) maxSpan.textContent = row.dataset.currentMax === '' ? '-' : row.dataset.currentMax;

    // Mark row as edited if current values differ from original ones
    try {
        const o = getRowOriginalNumbers(row);
        const n = getRowNumbers(row);
        const gradeEdited = (o.grade === null && n.grade !== null) || (o.grade !== null && n.grade !== null && Math.abs(o.grade - n.grade) > 0.001);
        const maxEdited = (o.max === null && n.max !== null) || (o.max !== null && n.max !== null && Math.abs(o.max - n.max) > 0.001);
        if (gradeEdited || maxEdited) row.classList.add('edited');
        else row.classList.remove('edited');
    } catch (e) {
        // non-fatal
    }
}

function updateRowComputedUI(row) {
    const pctCell = row.querySelector('.percentage');
    if (!pctCell) return;

    // keep row-actions node intact
    const actions = pctCell.querySelector('.row-actions');
    const pill = pctCell.querySelector('.grade-pill');

    const { grade, max } = getRowNumbers(row);
    if (row.classList.contains('dropped')) {
        // leave pill as-is but line-through handled by CSS
        return;
    }

    if (grade === null || max === null || max <= 0) {
        if (pill) pill.remove();
        // show '-' if there's no computable percentage
        if (!pctCell.querySelector('.muted') && !pctCell.textContent.trim().startsWith('-')) {
            // do nothing; template already has '-' for non-graded rows
        }
        if (actions && !actions.parentElement) pctCell.appendChild(actions);
        return;
    }

    const pct = (grade / max) * 100;
    const pillHtml = '<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(2) + '%</span>';
    if (pill) {
        pill.className = 'grade-pill ' + getGradeColorClass(pct);
        pill.textContent = pct.toFixed(2) + '%';
    } else {
        // insert before actions
        if (actions) actions.insertAdjacentHTML('beforebegin', pillHtml);
        else pctCell.insertAdjacentHTML('afterbegin', pillHtml);
    }
}

function bindGradesUiHandlers() {
    const container = document.querySelector('.grades-container');
    if (!container) return;

    // Consolidated click handler: edit/drop, course toggle, add custom assignment
    // Use capture phase so we can intercept before row-level inline onclick handlers.
    container.addEventListener('click', (e) => {
        // Edit / Reset / Drop
        const editBtn = e.target.closest('.row-action-edit');
        const dropBtn = e.target.closest('.row-action-drop');
        const resetBtn = e.target.closest('.row-action-reset');
        if (editBtn || dropBtn || resetBtn) {
            e.preventDefault();
            e.stopPropagation();
            const row = e.target.closest('tr.grade-row');
            if (!row) return;
            if (resetBtn) return resetRowEdits(row);
            if (dropBtn) return toggleDropRow(row);
            return openEditModal(row);
        }

        // Add custom assignment
        const addBtn = e.target.closest('.add-custom-assignment');
        if (addBtn) {
            e.preventDefault();
            e.stopPropagation();
            const sectionId = addBtn.dataset.section;
            const catIndex = addBtn.dataset.catIndex;
            if (!sectionId || catIndex === undefined) return;
            return addCustomAssignment(sectionId, catIndex);
        }

        // Course header toggle (ignore clicks on buttons inside header)
        const header = e.target.closest('.course-header.course-toggle');
        if (header && container.contains(header)) {
            if (e.target.closest('button')) return; // clicking button should not toggle
            const idx = header.dataset.courseIndex;
            if (idx === undefined) return;
            return toggleCourse(idx);
        }
    }, true);

    // Modal handlers
    const overlay = document.getElementById('grade-edit-overlay');
    const cancelBtn = document.getElementById('grade-edit-cancel');
    const saveBtn = document.getElementById('grade-edit-save');
    if (overlay && cancelBtn && saveBtn) {
        cancelBtn.addEventListener('click', closeEditModal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeEditModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeEditModal();
        });
        saveBtn.addEventListener('click', saveEditModal);
    }
}

function ensureEditsSlot(sectionId, assignmentId) {
    if (!gradeEdits[sectionId]) gradeEdits[sectionId] = {};
    if (!gradeEdits[sectionId][assignmentId]) gradeEdits[sectionId][assignmentId] = {};
    return gradeEdits[sectionId][assignmentId];
}

function toggleDropRow(row) {
    const { sectionId, assignmentId } = getRowKey(row);
    if (!sectionId || !assignmentId) return;
    const next = !row.classList.contains('dropped');
    setRowDropped(row, next);

    // Mark row as edited when dropped/undropped so the reset button appears
    try {
        if (next) row.classList.add('edited');
        else {
            // if undropping, only remove edited if there are no other edits
            // (applyEditsToRow will set edited based on numeric differences)
            row.classList.remove('edited');
        }
    } catch (e) {}

    const slot = ensureEditsSlot(sectionId, assignmentId);
    slot.dropped = next;
    saveGradeEdits();

    recalculateAllGrades(sectionId);
}

function openEditModal(row) {
    const overlay = document.getElementById('grade-edit-overlay');
    const scoreInput = document.getElementById('grade-edit-score');
    const maxInput = document.getElementById('grade-edit-max');
    const titleEl = document.getElementById('grade-edit-title');
    if (!overlay || !scoreInput || !maxInput) return;

    activeEditRow = row;

    const name = row.querySelector('.assignment-name')?.textContent?.trim() || 'Assignment';
    if (titleEl) titleEl.textContent = 'Edit: ' + name;

    const { grade, max } = getRowNumbers(row);
    scoreInput.value = (grade === null ? '' : String(grade));
    maxInput.value = (max === null ? '' : String(max));

    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => scoreInput.focus(), 0);
}

function closeEditModal() {
    const overlay = document.getElementById('grade-edit-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    activeEditRow = null;
}

function saveEditModal() {
    if (!activeEditRow) return;
    const scoreInput = document.getElementById('grade-edit-score');
    const maxInput = document.getElementById('grade-edit-max');
    if (!scoreInput || !maxInput) return;

    const scoreRaw = scoreInput.value.trim();
    const maxRaw = maxInput.value.trim();
    const scoreVal = (scoreRaw === '' ? null : Number(scoreRaw));
    const maxVal = (maxRaw === '' ? null : Number(maxRaw));
    if (scoreVal !== null && isNaN(scoreVal)) {
        showToast('Invalid grade value', 'error');
        return;
    }
    if (maxVal !== null && isNaN(maxVal)) {
        showToast('Invalid max value', 'error');
        return;
    }
    if (scoreVal !== null && scoreVal < 0) {
        showToast('Grade must be ≥ 0', 'error');
        return;
    }
    if (maxVal !== null && maxVal < 0) {
        showToast('Max must be ≥ 0', 'error');
        return;
    }

    // Apply to row
    activeEditRow.dataset.currentGrade = (scoreVal === null ? '' : String(scoreVal));
    activeEditRow.dataset.currentMax = (maxVal === null ? '' : String(maxVal));

    const gradeSpan = activeEditRow.querySelector('.grade-display');
    const maxSpan = activeEditRow.querySelector('.max-display');
    if (gradeSpan) gradeSpan.textContent = scoreVal === null ? '-' : String(scoreVal);
    if (maxSpan) maxSpan.textContent = maxVal === null ? '-' : String(maxVal);

    updateRowComputedUI(activeEditRow);

    // Persist
    const { sectionId, assignmentId } = getRowKey(activeEditRow);
    const slot = ensureEditsSlot(sectionId, assignmentId);
    slot.grade = scoreVal;
    slot.max = maxVal;
    saveGradeEdits();

    // Mark this row visually as edited
    try { activeEditRow.classList.add('edited'); } catch (e) {}

    recalculateAllGrades(sectionId);
    closeEditModal();
}

// Reset a single row to its original state (or remove custom assignment)
function resetRowEdits(row) {
    if (!row) return;
    const { sectionId, assignmentId } = getRowKey(row);
    if (!sectionId || !assignmentId) return;

    // If custom assignment, remove it entirely
    if (row.dataset.kind === 'custom') {
        // remove from DOM
        row.remove();
        // remove from in-memory store
        if (gradesCustomAssignments[sectionId]) {
            Object.keys(gradesCustomAssignments[sectionId]).forEach(catIndex => {
                gradesCustomAssignments[sectionId][catIndex] = gradesCustomAssignments[sectionId][catIndex].filter(a => a.id !== assignmentId);
                if (gradesCustomAssignments[sectionId][catIndex].length === 0) delete gradesCustomAssignments[sectionId][catIndex];
            });
            if (Object.keys(gradesCustomAssignments[sectionId]).length === 0) delete gradesCustomAssignments[sectionId];
        }
        // remove any persisted edits for this id
        if (gradeEdits?.[sectionId]?.[assignmentId]) {
            delete gradeEdits[sectionId][assignmentId];
            if (Object.keys(gradeEdits[sectionId]).length === 0) delete gradeEdits[sectionId];
            saveGradeEdits();
        }
        saveCustomAssignments();
        // update UI
        document.querySelectorAll('.grade-row[data-section="' + sectionId + '"]').forEach(r => updateRowComputedUI(r));
        recalculateAllGrades(sectionId);
        showToast('Removed custom assignment', 'success');
        return;
    }

    // Official row: restore original numbers and removed dropped state
    const o = getRowOriginalNumbers(row);
    row.dataset.currentGrade = (o.grade === null ? '' : String(o.grade));
    row.dataset.currentMax = (o.max === null ? '' : String(o.max));
    setRowDropped(row, false);

    const gradeSpan = row.querySelector('.grade-display');
    const maxSpan = row.querySelector('.max-display');
    if (gradeSpan) gradeSpan.textContent = o.grade === null ? '-' : String(o.grade);
    if (maxSpan) maxSpan.textContent = o.max === null ? '-' : String(o.max);

    updateRowComputedUI(row);

    // remove edited visual marker when resetting to original
    try { row.classList.remove('edited'); } catch (e) {}

    // remove persisted edits for this row
    if (gradeEdits?.[sectionId]?.[assignmentId]) {
        delete gradeEdits[sectionId][assignmentId];
        if (Object.keys(gradeEdits[sectionId]).length === 0) delete gradeEdits[sectionId];
        saveGradeEdits();
    }

    recalculateAllGrades(sectionId);
    showToast('Reverted changes for assignment', 'success');
}

// Toggle course grades visibility
function toggleCourse(index) {
    try {
        const container = document.getElementById('course-' + index);
        if (!container) {
            console.error('toggleCourse: Could not find course-' + index);
            return;
        }
        const header = container.previousElementSibling;
        const card = header ? header.parentElement : null;
        
        if (container.style.display === 'none') {
            container.style.display = 'block';
            if (header) header.classList.add('open');
            if (card) card.classList.add('open');
        } else {
            container.style.display = 'none';
            if (header) header.classList.remove('open');
            if (card) card.classList.remove('open');
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

// Legacy inline-edit functions removed from UI; kept unused intentionally.

// Add custom assignment to a category
function addCustomAssignment(sectionId, catIndex) {
    const nameInput = document.getElementById('custom-name-' + sectionId + '-' + catIndex);
    const scoreInput = document.getElementById('custom-score-' + sectionId + '-' + catIndex);
    const maxInput = document.getElementById('custom-max-' + sectionId + '-' + catIndex);
    
    const name = nameInput.value.trim() || 'Custom Assignment';
    const score = parseFloat(scoreInput.value);
    let max = parseFloat(maxInput.value);
    if (isNaN(max)) max = 100;
    
    if (isNaN(score)) {
        showToast('Please enter a score', 'error');
        return;
    }
    
    if (score < 0 || max < 0) {
        showToast('Please enter valid values', 'error');
        return;
    }
    
    // Create custom assignment
    const customId = 'custom-' + (customIdCounter++);
    const assignment = {
        id: customId,
        title: name,
        score: score,
        max: max,
        sectionId: sectionId,
        catIndex: catIndex
    };
    
    // Store custom assignment
    if (!gradesCustomAssignments[sectionId]) {
        gradesCustomAssignments[sectionId] = {};
    }
    if (!gradesCustomAssignments[sectionId][catIndex]) {
        gradesCustomAssignments[sectionId][catIndex] = [];
    }
    gradesCustomAssignments[sectionId][catIndex].push(assignment);
    
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
    
    const maxVal = (assignment.max !== undefined && assignment.max !== null && !isNaN(Number(assignment.max))) ? Number(assignment.max) : 100;
    const scoreVal = (assignment.score !== undefined && assignment.score !== null && !isNaN(Number(assignment.score))) ? Number(assignment.score) : 0;
    const pct = (maxVal > 0) ? (scoreVal / maxVal) * 100 : 0;
    const row = document.createElement('tr');
    row.className = 'grade-row clickable-row custom-assignment-row';
    row.dataset.section = assignment.sectionId;
    row.dataset.assignment = assignment.id;
    row.dataset.kind = 'custom';
    row.dataset.originalGrade = '';
    row.dataset.originalMax = '';
    row.dataset.currentGrade = String(scoreVal);
    row.dataset.currentMax = String(maxVal);

    const pctHtml = (maxVal > 0)
        ? ('<span class="grade-pill ' + getGradeColorClass(pct) + '">' + pct.toFixed(2) + '%</span>')
        : '<span class="muted">N/A</span>';

    row.innerHTML =
        '<td class="assignment-name">' + (assignment.title || assignment.name || 'Custom Assignment') + '<span class="custom-badge">Custom</span></td>' +
        '<td class="due-date">-</td>' +
        '<td class="grade-value"><span class="grade-display">' + scoreVal + '</span></td>' +
        '<td class="max-points"><span class="max-display">' + maxVal + '</span></td>' +
        '<td class="percentage">' +
            pctHtml +
            '<span class="row-actions" aria-hidden="true">' +
                '<button type="button" class="row-action-edit" title="Edit">✎</button>' +
                '<button type="button" class="row-action-drop" title="Drop">🗑</button>' +
            '</span>' +
        '</td>';
    
    tbody.appendChild(row);
}

// Toggle debug panel visibility for a section
function toggleDebug(sectionId) {
    const debugKey = 'gradeDebugOpen:' + sectionId;
    const current = localStorage.getItem(debugKey) === '1';
    const newVal = current ? '0' : '1';
    localStorage.setItem(debugKey, newVal);

    const btn = document.querySelector('.debug-toggle[data-section="' + sectionId + '"]');
    const debugEl = document.getElementById('grade-debug-' + sectionId);
    if (btn) {
        if (newVal === '1') btn.classList.add('active');
        else btn.classList.remove('active');
    }
    if (debugEl) debugEl.style.display = newVal === '1' ? 'block' : 'none';
    recalculateAllGrades(sectionId);
}

// Recalculate grades and update UI for a section
function recalculateAllGrades(sectionId) {
    const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (!courseCard) return;

    let newSectionEarned = 0;
    let newSectionMax = 0;
    let originalSectionEarned = 0;
    let originalSectionMax = 0;
    let hasChanges = false;
    const debugLines = [];

    courseCard.querySelectorAll('.category-section').forEach(catSection => {
        const catIndex = catSection.dataset.category;
        let catHasChanges = false;
        const catGradeDiv = catSection.querySelector('.category-grade');
        const originalCatPctFromServer = (catGradeDiv && catGradeDiv.dataset.originalPct !== '') ? Number(catGradeDiv.dataset.originalPct) : null;

        let newCatEarned = 0;
        let newCatMax = 0;
        let originalCatEarned = 0;
        let originalCatMax = 0;
        const catWeight = parseFloat(catSection.dataset.weight) || 0;

        catSection.querySelectorAll('tr.grade-row').forEach(row => {
            const isCustom = row.dataset.kind === 'custom';
            const dropped = row.classList.contains('dropped');
            if (dropped) { hasChanges = true; catHasChanges = true; }

            // original values (official rows only)
            if (!isCustom) {
                const o = getRowOriginalNumbers(row);
                if (o.grade !== null && o.max !== null) {
                    if (o.max > 0) {
                        originalCatEarned += o.grade;
                        originalCatMax += o.max;
                    } else {
                        // max === 0 => treat as extra credit: include earned points but not in max
                        originalCatEarned += o.grade;
                    }
                }
            }

            // new/current values (include custom, exclude dropped)
            if (!dropped) {
                const n = getRowNumbers(row);
                if (n.grade !== null && n.max !== null) {
                    if (n.max > 0) {
                        newCatEarned += n.grade;
                        newCatMax += n.max;
                    } else {
                        // max === 0 => extra credit: include earned but do not add to max
                        newCatEarned += n.grade;
                    }
                }
            }

            // detect edits on official rows
            if (!isCustom) {
                const o2 = getRowOriginalNumbers(row);
                const n = getRowNumbers(row);
                if ((n.grade !== null && o2.grade !== null && Math.abs(n.grade - o2.grade) > 0.001) ||
                    (n.max !== null && o2.max !== null && Math.abs(n.max - o2.max) > 0.001)) {
                    hasChanges = true; catHasChanges = true;
                }
            } else {
                // presence of custom assignment counts as change
                hasChanges = true; catHasChanges = true;
            }
        });

        newSectionEarned += newCatEarned;
        newSectionMax += newCatMax;
        originalSectionEarned += originalCatEarned;
        originalSectionMax += originalCatMax;

        const newCatPct = newCatMax > 0 ? (newCatEarned / newCatMax * 100) : 0;
        const originalCatPctVal = originalCatMax > 0 ? (originalCatEarned / originalCatMax * 100) : (originalCatMax === 0 ? null : 0);

        // Update category edited UI. If original server value is missing, still show calculated value.
        const catEditedElId = 'cat-edited-' + sectionId + '-' + catIndex;
        let catEditedEl = document.getElementById(catEditedElId);
        const catGradeContainer = catSection.querySelector('.category-grade');
        // preserve server-original HTML for this category so we can restore it
        if (catGradeContainer && catGradeContainer.dataset && !catGradeContainer.dataset.serverOriginalHtml) {
            const primaryEl = catGradeContainer.querySelector('.category-original');
            catGradeContainer.dataset.serverOriginalHtml = primaryEl ? primaryEl.innerHTML : '';
        }
        // Show edited indicator for a category if there are actual changes (edits, drops, or custom assignments).
        // If the server value is missing, show the calculated percent as primary.
        const shouldShowEdited = originalCatPctFromServer !== null && catHasChanges;

        if (shouldShowEdited) {
            // ensure category-grade has an edited slot; create if template didn't include it
            if (!catEditedEl) {
                const catGradeContainer = catSection.querySelector('.category-grade');
                if (catGradeContainer) {
                    catEditedEl = document.createElement('span');
                    catEditedEl.id = catEditedElId;
                    catEditedEl.className = 'category-edited';
                    catEditedEl.style.display = 'inline';
                    catEditedEl.innerHTML = '→ <span class="edited-val"></span>';
                    catGradeContainer.appendChild(catEditedEl);
                }
            } else {
                catEditedEl.style.display = 'inline';
            }
            if (catEditedEl) {
                const ev = catEditedEl.querySelector('.edited-val');
                if (ev) ev.innerHTML = '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + newCatPct.toFixed(2) + '%</span>' +
                                     '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + getLetterGrade(newCatPct) + '</span>';
                // Set the primary display to the server-original percentage (computed),
                // falling back to cached HTML if the numeric value is not available.
                if (catGradeContainer) {
                    const primary = catGradeContainer.querySelector('.category-original');
                    if (primary) {
                        if (originalCatPctVal !== null) {
                            primary.innerHTML = '<span class="grade-pill ' + getGradeColorClass(originalCatPctVal) + '">' + originalCatPctVal.toFixed(2) + '%</span>' +
                                                 '<span class="grade-pill ' + getGradeColorClass(originalCatPctVal) + '">' + getLetterGrade(originalCatPctVal) + '</span>';
                            primary.className = 'category-original ' + getGradeColorClass(originalCatPctVal);
                        } else {
                            const serverHtml = catGradeContainer.dataset.serverOriginalHtml;
                            if (serverHtml !== undefined) primary.innerHTML = serverHtml;
                        }
                    }
                }
            }
        } else if (catEditedEl) {
            catEditedEl.style.display = 'none';
        }

        const catTitle = catSection.querySelector('.category-title')?.textContent || ('Category ' + catIndex);
        const originalEarnedDisplay = originalCatMax > 0
            ? originalCatEarned.toFixed(2) + '/' + originalCatMax.toFixed(2) + ' (' + (originalCatPctVal !== null ? originalCatPctVal.toFixed(2) + '%' : 'N/A') + ')'
            : (originalCatMax === 0 ? 'N/A' : '0');
        const newEarnedDisplay = newCatMax > 0
            ? newCatEarned.toFixed(2) + '/' + newCatMax.toFixed(2) + ' (' + newCatPct.toFixed(2) + '%)'
            : 'N/A';

        // Record category summary for later contribution calculation.
        const hasAssignments = (originalCatMax > 0) || (newCatMax > 0);
        debugLines.push({
            title: catTitle,
            weight: catWeight,
            originalEarned: originalEarnedDisplay,
            newEarned: newEarnedDisplay,
            originalPct: originalCatPctVal !== null ? originalCatPctVal : null,
            newPct: newCatPct,
            originalCatEarned: originalCatEarned,
            originalCatMax: originalCatMax,
            newCatEarned: newCatEarned,
            newCatMax: newCatMax,
            hasAssignments: hasAssignments,
            originalContribution: 0,
            newContribution: 0
        });

        // Ensure category header reflects calculated value when original server value is missing or differs without user changes.
        try {
            const catGradeContainer = catSection.querySelector('.category-grade');
            if (catGradeContainer) {
                const roundedNewPct = Math.round(newCatPct * 10) / 10;
                const roundedOrigPct = Math.round(originalCatPctFromServer * 10) / 10;
                // If server has original pct, and no user changes, but calculated differs, show calculated as primary
                if (originalCatPctFromServer !== null && !catHasChanges && Math.abs(roundedNewPct - roundedOrigPct) > 0) {
                    // update primary to calculated
                    let primary = catGradeContainer.querySelector('.category-original');
                    const pillHtml = '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + newCatPct.toFixed(2) + '%</span>' +
                                     '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + getLetterGrade(newCatPct) + '</span>';
                    if (primary) {
                        primary.innerHTML = pillHtml;
                        primary.className = 'category-original ' + getGradeColorClass(newCatPct);
                    }
                    // hide edited element
                    const existingEdited = document.getElementById('cat-edited-' + sectionId + '-' + catIndex);
                    if (existingEdited) existingEdited.style.display = 'none';
                }
                // If server has no original pct, show calculated as primary
                else if (originalCatPctFromServer === null && newCatMax > 0) {
                    let primary = catGradeContainer.querySelector('.category-original');
                    const pillHtml = '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + newCatPct.toFixed(2) + '%</span>' +
                                     '<span class="grade-pill ' + getGradeColorClass(newCatPct) + '">' + getLetterGrade(newCatPct) + '</span>';
                    if (!primary) {
                        primary = document.createElement('span');
                        primary.className = 'category-original';
                        primary.innerHTML = pillHtml;
                        catGradeContainer.insertBefore(primary, catGradeContainer.firstChild);
                    } else {
                        primary.innerHTML = pillHtml;
                        primary.className = 'category-original ' + getGradeColorClass(newCatPct);
                    }
                    // hide edited element
                    const existingEdited = document.getElementById('cat-edited-' + sectionId + '-' + catIndex);
                    if (existingEdited) existingEdited.style.display = 'none';
                }
            }
        } catch (e) {
            // non-fatal
        }
    });

    const weightedMode = debugLines.some(dl => dl.weight > 0);
    let sumOrigContrib = 0;
    let sumNewContrib = 0;

    if (weightedMode) {
        // Redistribute weights among only categories that have assignments
        const totalActiveWeight = debugLines.reduce((s, dl) => s + (dl.weight > 0 && dl.hasAssignments ? dl.weight : 0), 0);
        // If no active weights, fallback to point-based (treated below)
        if (totalActiveWeight > 0) {
            debugLines.forEach(dl => {
                const origPct = dl.originalPct !== null ? Number(dl.originalPct) : null;
                if (origPct !== null) dl.originalContribution = origPct * (dl.weight > 0 ? (dl.weight / totalActiveWeight) : 0);
                else dl.originalContribution = 0;

                if (dl.newCatMax > 0) dl.newContribution = dl.newPct * (dl.weight > 0 ? (dl.weight / totalActiveWeight) : 0);
                else dl.newContribution = 0;

                sumOrigContrib += Number(dl.originalContribution) || 0;
                sumNewContrib += Number(dl.newContribution) || 0;
            });
        } else {
            // No active weighted categories; fall back to point-based below by leaving sums as 0
        }
    }

    // If not weighted mode or weighted fallback, compute contributions by points
    if (!weightedMode || (weightedMode && sumNewContrib === 0)) {
        debugLines.forEach(dl => {
            const origContrib = (dl.originalCatMax > 0 && originalSectionMax > 0) ? (dl.originalCatEarned / originalSectionMax * 100) : 0;
            const newContrib = (dl.newCatMax > 0 && newSectionMax > 0) ? (dl.newCatEarned / newSectionMax * 100) : 0;
            dl.originalContribution = origContrib;
            dl.newContribution = newContrib;
            sumOrigContrib += origContrib;
            sumNewContrib += newContrib;
        });
    }

    // Update section totals
    const earnedEl = document.getElementById('earned-' + sectionId);
    const totalEl = document.getElementById('total-' + sectionId);
    if (earnedEl) earnedEl.textContent = newSectionEarned.toFixed(2);
    if (totalEl) totalEl.textContent = newSectionMax.toFixed(2);

    const newSectionPct = weightedMode ? sumNewContrib : (newSectionMax > 0 ? (newSectionEarned / newSectionMax * 100) : 0);

    const editedSectionEl = document.getElementById('edited-section-' + sectionId);
    const originalGradeEl = courseCard.querySelector('.original-grade');
    const originalPctStr = originalGradeEl?.dataset.originalPct;
    const hasOriginalGrade = originalPctStr !== '' && originalPctStr !== undefined && originalPctStr !== null;
    const originalSectionPct = hasOriginalGrade ? parseFloat(originalPctStr) : null;

    if (editedSectionEl) {
        const shouldShowCalculated = hasChanges && (
            (hasOriginalGrade && Math.abs(newSectionPct - originalSectionPct) > 0.01) ||
            (!hasOriginalGrade && newSectionMax > 0)
        );

        if (shouldShowCalculated) {
            editedSectionEl.style.display = 'flex';
            const pctEl = document.getElementById('edited-pct-' + sectionId);
            const letterEl = document.getElementById('edited-letter-' + sectionId);
            if (pctEl) { pctEl.className = 'grade-pill ' + getGradeColorClass(newSectionPct); pctEl.textContent = newSectionPct.toFixed(2) + '%'; }
            if (letterEl) { letterEl.className = 'grade-pill ' + getGradeColorClass(newSectionPct); letterEl.textContent = getLetterGrade(newSectionPct); }
        } else {
            editedSectionEl.style.display = 'none';
        }
    }

    // Render debug panel
    const debugEl = document.getElementById('grade-debug-' + sectionId);
    if (debugEl) {
        const debugOpenKey = 'gradeDebugOpen:' + sectionId;
        const debugOpenByUser = localStorage.getItem(debugOpenKey) === '1';

        if (!hasChanges && !debugOpenByUser) {
            debugEl.style.display = 'none';
        } else {
            debugEl.style.display = 'block';
            let html = '';
            html += '<div class="row"><div><strong>Section Grade Debug</strong> <span class="muted">(detailed calculation)</span></div><div></div></div>';
            if (!hasChanges) {
                html += '<div class="row"><div class="muted">No changes detected — showing calculated values for reference.</div><div></div></div>';
                html += '<hr style="opacity:0.06; border: none; border-top: 1px solid rgba(0,0,0,0.06); margin: var(--space-2) 0;">';
            }
            html += '<div class="row"><div class="muted">Original Section Grade:</div><div>' + (originalSectionPct !== null ? originalSectionPct.toFixed(2) + '%' : 'N/A') + '</div></div>';
            html += '<div class="row"><div class="muted">Calculated Section Grade:</div><div>' + newSectionPct.toFixed(2) + '%</div></div>';
            html += '<div class="row"><div class="muted">Difference:</div><div>' + (originalSectionPct !== null ? (newSectionPct - originalSectionPct).toFixed(2) + '%' : (newSectionPct.toFixed(2) + '%')) + '</div></div>';
            html += '<hr style="opacity:0.06; border: none; border-top: 1px solid rgba(0,0,0,0.06); margin: var(--space-2) 0;">';
            html += '<div class="muted">Category breakdown:</div>';
            debugLines.forEach(dl => {
                html += '<div class="row"><div>' + dl.title + (dl.weight > 0 ? ' <span class="muted">(' + dl.weight + '%)</span>' : '') + '</div>';
                html += '<div class="muted">Orig: ' + dl.originalEarned + ' • New: ' + dl.newEarned + '</div></div>';
                if (weightedMode) {
                    html += '<div class="row"><div class="muted">Orig Contribution:</div><div>' + dl.originalContribution + '%</div></div>';
                    html += '<div class="row"><div class="muted">New Contribution:</div><div>' + dl.newContribution + '%</div></div>';
                } else {
                    html += '<div class="row"><div class="muted">Contribution by points:</div><div>Orig ' + dl.originalContribution + '% • New ' + dl.newContribution + '%</div></div>';
                }
                html += '<hr style="opacity:0.02; border: none; border-top: 1px solid rgba(0,0,0,0.02); margin: var(--space-2) 0;">';
            });
            if (weightedMode) {
                html += '<div class="row"><div class="muted">Sum Orig Contributions:</div><div>' + sumOrigContrib.toFixed(2) + '%</div></div>';
                html += '<div class="row"><div class="muted">Sum New Contributions:</div><div>' + sumNewContrib.toFixed(2) + '%</div></div>';
            } else {
                html += '<div class="row"><div class="muted">Total section points:</div><div>' + newSectionEarned.toFixed(2) + '/' + newSectionMax.toFixed(2) + '</div></div>';
            }

            debugEl.innerHTML = html;
        }
    }
}

// On page load, set debug button states from localStorage
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.debug-toggle').forEach(btn => {
        const sectionId = btn.dataset.section;
        const val = localStorage.getItem('gradeDebugOpen:' + sectionId) === '1';
        if (val) btn.classList.add('active');
    });
    // Recalculate all sections with debug toggles enabled so panels show on load
    document.querySelectorAll('.debug-toggle.active').forEach(btn => {
        const sectionId = btn.dataset.section;
        try { recalculateAllGrades(sectionId); } catch(e) { console.warn('recalc failed for debug open', e); }
    });
});

// Expose debug helper globally to support inline onclick handlers if needed
try { window.toggleDebug = toggleDebug; } catch (e) { /* ignore if document/window not present */ }

// Save/Load functions
// Legacy modifiedGrades cookie no longer used; gradeEdits replaces it.

function saveCustomAssignments() {
    // Persist as a flat array to remain compatible with assignments list
    const flat = [];
    Object.keys(gradesCustomAssignments).forEach(sectionId => {
        Object.keys(gradesCustomAssignments[sectionId]).forEach(catIndex => {
            gradesCustomAssignments[sectionId][catIndex].forEach(a => {
                flat.push({
                    id: a.id,
                    title: a.title || a.name || '',
                    score: (a.score !== undefined && a.score !== null) ? Number(a.score) : 0,
                    max: (a.max !== undefined && a.max !== null && !isNaN(Number(a.max))) ? Number(a.max) : 100,
                    sectionId: a.sectionId,
                    catIndex: a.catIndex
                });
            });
        });
    });
    setCookie('customAssignments', flat);
}

function loadCustomAssignments() {
    const saved = getCookie('customAssignments');
    
    if (saved) {
        // Saved may be a flat array; convert to internal mapping
        if (Array.isArray(saved)) {
            // Clear any existing
            Object.keys(gradesCustomAssignments).forEach(k => delete gradesCustomAssignments[k]);
            saved.forEach(a => {
                    // coerce saved values to numbers where appropriate to avoid string/undefined issues
                    const sectionId = a.sectionId;
                    const catIndex = a.catIndex;
                    const id = a.id;
                    const title = a.title || a.name || '';
                    const score = (a.score !== undefined && a.score !== null) ? Number(a.score) : 0;
                    const max = (a.max !== undefined && a.max !== null && !isNaN(Number(a.max))) ? Number(a.max) : null;

                    if (!gradesCustomAssignments[sectionId]) gradesCustomAssignments[sectionId] = {};
                    if (!gradesCustomAssignments[sectionId][catIndex]) gradesCustomAssignments[sectionId][catIndex] = [];
                    gradesCustomAssignments[sectionId][catIndex].push({
                        id: id,
                        title: title,
                        score: score,
                        max: max,
                        sectionId: sectionId,
                        catIndex: catIndex
                    });
            });
        } else if (typeof saved === 'object') {
            Object.assign(gradesCustomAssignments, saved);
        }

        // Recreate custom assignment rows
        Object.keys(gradesCustomAssignments).forEach(sectionId => {
            Object.keys(gradesCustomAssignments[sectionId]).forEach(catIndex => {
                gradesCustomAssignments[sectionId][catIndex].forEach(assignment => {
                    addCustomAssignmentRow(assignment);
                });
            });
            recalculateAllGrades(sectionId);
        });
        // Apply persisted drops/edits to custom rows after creation
        try {
            document.querySelectorAll('.grade-row.custom-assignment-row').forEach(row => {
                applyEditsToRow(row);
                updateRowComputedUI(row);
            });
        } catch (e) {
            // ignore
        }
    }
}

// Reset all changes
function resetAllChanges() {
    if (!confirm('Are you sure you want to reset all grade changes and remove custom assignments?')) {
        return;
    }

    // Reset official rows to original values and clear dropped state
    document.querySelectorAll('.grade-row[data-kind="official"]').forEach(row => {
        const o = getRowOriginalNumbers(row);
        row.dataset.currentGrade = (o.grade === null ? '' : String(o.grade));
        row.dataset.currentMax = (o.max === null ? '' : String(o.max));
        setRowDropped(row, false);

        const gradeSpan = row.querySelector('.grade-display');
        const maxSpan = row.querySelector('.max-display');
        if (gradeSpan) gradeSpan.textContent = o.grade === null ? '-' : String(o.grade);
        if (maxSpan) maxSpan.textContent = o.max === null ? '-' : String(o.max);
        updateRowComputedUI(row);
    });
    
    // Remove custom assignment rows
    document.querySelectorAll('.custom-assignment-row').forEach(row => {
        row.remove();
    });

    // Clear storage
    Object.keys(gradeEdits).forEach(key => delete gradeEdits[key]);
    Object.keys(gradesCustomAssignments).forEach(key => delete gradesCustomAssignments[key]);
    
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
    deleteCookie('gradeEdits');
    deleteCookie('customAssignments');
    
    showToast('All changes have been reset', 'success');
}

// Reset changes for a single section (reverts official edits, removes custom assignments)
function resetSection(sectionId) {
    if (!confirm('Reset changes for this section?')) return;

    // Reset official rows for this section
    document.querySelectorAll('.grade-row[data-section="' + sectionId + '"][data-kind="official"]').forEach(row => {
        const o = getRowOriginalNumbers(row);
        row.dataset.currentGrade = (o.grade === null ? '' : String(o.grade));
        row.dataset.currentMax = (o.max === null ? '' : String(o.max));
        setRowDropped(row, false);

        const gradeSpan = row.querySelector('.grade-display');
        const maxSpan = row.querySelector('.max-display');
        if (gradeSpan) gradeSpan.textContent = o.grade === null ? '-' : String(o.grade);
        if (maxSpan) maxSpan.textContent = o.max === null ? '-' : String(o.max);
        // remove edited marker
        try { row.classList.remove('edited'); } catch (e) {}
        updateRowComputedUI(row);
    });

    // Remove custom assignment rows for this section
    document.querySelectorAll('.custom-assignment-row[data-section="' + sectionId + '"]').forEach(row => {
        row.remove();
    });

    // Clear persisted edits for this section
    if (gradeEdits?.[sectionId]) {
        delete gradeEdits[sectionId];
        saveGradeEdits();
    }

    // Clear custom assignments for this section
    if (gradesCustomAssignments[sectionId]) {
        delete gradesCustomAssignments[sectionId];
        saveCustomAssignments();
    }

    // Recalculate and hide edited displays for the section
    recalculateAllGrades(sectionId);
    const editedSection = document.getElementById('edited-section-' + sectionId);
    if (editedSection) editedSection.style.display = 'none';
    const card = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (card) card.querySelectorAll('.category-edited').forEach(el => el.style.display = 'none');

    showToast('Reset changes for section', 'success');
}

try { window.resetSection = resetSection; } catch (e) {}
