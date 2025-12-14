// Assignments page functionality

const assignmentsCustomStorageKey = 'assignmentsCustomAssignments';
const assignmentsCustomEntries = [];

function initAssignmentsPage() {
    try {
        loadCompletedAssignments();
        initCustomAssignmentsUi();
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
        if (courseFilter !== 'all' && sectionId !== courseFilter) {
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

function normalizeCustomAssignmentPayload(payload = {}) {
    const minutes = Number(payload.estimatedMinutes);
    const titleCandidate = (payload.title || 'Custom assignment').trim();
    return {
        id: payload.id ? String(payload.id) : `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: titleCandidate || 'Custom assignment',
        course: (payload.course || '').trim(),
        dueDate: payload.dueDate ? String(payload.dueDate).trim() : null,
        dueTime: payload.dueTime ? String(payload.dueTime).trim() : null,
        estimatedMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 30,
        createdAt: payload.createdAt ? Number(payload.createdAt) : Date.now()
    };
}

function loadCustomAssignmentsFromStorage() {
    assignmentsCustomEntries.length = 0;
    try {
        const savedRaw = localStorage.getItem(assignmentsCustomStorageKey);
        if (!savedRaw) return;
        const saved = JSON.parse(savedRaw);
        if (!Array.isArray(saved)) return;
        saved.forEach(item => {
            assignmentsCustomEntries.push(normalizeCustomAssignmentPayload(item));
        });
    } catch (e) {
        console.warn('Failed to load custom assignments from storage:', e);
    }
}

function saveCustomAssignmentsToStorage() {
    try {
        localStorage.setItem(assignmentsCustomStorageKey, JSON.stringify(assignmentsCustomEntries));
    } catch (e) {
        console.warn('Failed to save custom assignments to storage:', e);
    }
}

function initCustomAssignmentsUi() {
    const form = document.getElementById('custom-assignment-form');
    if (!form) return;

    loadCustomAssignmentsFromStorage();
    clearCustomAssignmentsDom();

    assignmentsCustomEntries.forEach(entry => {
        insertCustomAssignmentElement(entry, { silent: true, skipUpdate: true });
    });

    renderCustomAssignmentsList();
    bindCustomListEvents();

    if (!form.dataset.customListener) {
        form.addEventListener('submit', handleCustomAssignmentFormSubmit);
        form.dataset.customListener = '1';
    }
}

function handleCustomAssignmentFormSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = (form.elements.title?.value || '').trim();
    const course = (form.elements.course?.value || '').trim();
    const dueDate = (form.elements.dueDate?.value || '').trim();
    const dueTime = (form.elements.dueTime?.value || '').trim();
    const durationValue = form.elements.duration?.value;
    const assignmentDuration = durationValue ? Number(durationValue) : 0;

    if (!title) {
        showToast('Give your custom assignment a title', 'error');
        return;
    }

    const assignment = normalizeCustomAssignmentPayload({
        title,
        course,
        dueDate: dueDate || null,
        dueTime: dueTime || null,
        estimatedMinutes: assignmentDuration
    });

    assignmentsCustomEntries.push(assignment);
    saveCustomAssignmentsToStorage();
    insertCustomAssignmentElement(assignment);
    renderCustomAssignmentsList();
    form.reset();
}

function insertCustomAssignmentElement(assignment, options = {}) {
    const upcomingList = document.getElementById('upcoming-day-list');
    if (!upcomingList) return;
    if (document.querySelector(`.assignment-item.custom-assignment[data-id="${assignment.id}"]`)) return;

    const info = getCustomDayKeyInfo(assignment);
    const dayGroup = ensureCustomDayGroup(info.dayKey, info.dueDate, upcomingList);
    if (!dayGroup) return;

    const container = dayGroup.querySelector('.day-assignments');
    if (!container) return;

    const assignmentEl = buildCustomAssignmentElement(assignment, info);
    if (!assignmentEl) return;

    container.appendChild(assignmentEl);
    adjustDayTotal(info.dayKey, 1);
    adjustUpcomingCompletionTotal(1);
    adjustTotalTimeMinutes(assignment.estimatedMinutes);

    if (!options.skipUpdate && typeof updateDayCompletions === 'function') {
        updateDayCompletions();
    }

    if (!options.silent && typeof showToast === 'function') {
        showToast('Custom assignment added', 'success');
    }
}

function getCustomDayKeyInfo(assignment) {
    if (!assignment.dueDate) return { dayKey: 'no-due', dueDate: null };
    const timeSegment = assignment.dueTime || '23:59';
    const parsed = new Date(`${assignment.dueDate}T${timeSegment}`);
    if (isNaN(parsed)) return { dayKey: 'no-due', dueDate: null };
    const dayKey = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    return { dayKey, dueDate: parsed };
}

function ensureCustomDayGroup(dayKey, dueDate, list) {
    const existing = list.querySelector(`.day-group[data-day="${dayKey}"]`);
    if (existing) return existing;
    const group = createCustomDayGroup(dayKey, dueDate);
    insertCustomDayGroupSorted(list, group, dayKey, dueDate);
    return group;
}

function createCustomDayGroup(dayKey, dueDate) {
    const wrapper = document.createElement('div');
    const isNoDue = dayKey === 'no-due';
    const labelInfo = isNoDue ? { label: 'No Due Date', className: '' } : getDayLabelInfo(dueDate);
    const dayClass = labelInfo.className ? `day-date ${labelInfo.className}` : 'day-date';
    const completionHtml = `
            <div class="completion-bar">
                <div class="completion-fill" style="width: 0%"></div>
            </div>
            <span class="completion-text">0/0 (0%)</span>
    `;
    const stats = isNoDue ? `
            <div class="day-stats">
                <div class="day-completion" data-day="${dayKey}" data-total="0">
                    ${completionHtml}
                </div>
            </div>
    ` : `
            <div class="day-stats">
                <div class="day-time" title="Total estimated time">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ~0 min
                </div>
                <div class="day-completion" data-day="${dayKey}" data-total="0">
                    ${completionHtml}
                </div>
            </div>
    `;

    wrapper.innerHTML = `
        <div class="day-group" data-day="${dayKey}">
            <div class="${isNoDue ? 'day-header no-due' : 'day-header'}">
                <div class="day-header-left">
                    <span class="${dayClass}">${labelInfo.label}</span>
                </div>
                ${stats}
            </div>
            <div class="day-assignments"></div>
        </div>
    `;

    return wrapper.firstElementChild;
}

function insertCustomDayGroupSorted(list, group, dayKey, dueDate) {
    const groups = Array.from(list.querySelectorAll(':scope > .day-group'));
    if (dayKey === 'no-due') {
        list.appendChild(group);
        return;
    }

    for (const existing of groups) {
        const existingKey = existing.dataset.day;
        if (existingKey === 'no-due') {
            list.insertBefore(group, existing);
            return;
        }
        const existingDate = getDateFromDayKey(existingKey);
        if (existingDate && dueDate < existingDate) {
            list.insertBefore(group, existing);
            return;
        }
    }

    list.appendChild(group);
}

function getDayLabelInfo(date) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysUntil = Math.round((targetStart - todayStart) / (1000 * 60 * 60 * 24));
    if (daysUntil === 0) return { label: 'Today', className: 'today' };
    if (daysUntil === 1) return { label: 'Tomorrow', className: 'tomorrow' };
    return { label: date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }), className: '' };
}

function getDateFromDayKey(dayKey) {
    if (!dayKey || dayKey === 'no-due') return null;
    const parts = dayKey.split('-');
    if (parts.length !== 3) return null;
    const [year, month, day] = parts.map(Number);
    return new Date(year, month - 1, day);
}

function buildCustomAssignmentElement(assignment, info) {
    const dayKey = info.dayKey;
    const dueDate = info.dueDate;
    const dueTimeText = dueDate ? getCustomDueTimeText(dueDate) : '';
    const timeClass = getTimeEstimateClass(assignment.estimatedMinutes);
    const durationText = formatCustomDuration(assignment.estimatedMinutes);
    const courseLabel = assignment.course || 'Custom';
    const safeId = assignment.id.replace(/"/g, '&quot;');

    if (!dayKey) return null;

    const element = document.createElement('div');
    element.className = 'assignment-item custom-assignment';
    element.dataset.id = assignment.id;
    element.dataset.section = 'custom';
    element.dataset.day = dayKey;
    element.dataset.time = String(assignment.estimatedMinutes);
    element.innerHTML = `
        <div class="assignment-checkbox" onclick="toggleComplete('${safeId}', this); event.stopPropagation();" id="check-${safeId}"></div>
        <div class="assignment-content">
            <div class="assignment-title">${escapeHtml(assignment.title)}</div>
            <div class="assignment-meta">
                <span class="assignment-course">${escapeHtml(courseLabel)}</span>
                ${dueTimeText ? `<span class="assignment-due">${dueTimeText}</span>` : ''}
                <span class="time-estimate ${timeClass}" title="Estimated time to complete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${durationText}
                </span>
            </div>
        </div>
        <div class="assignment-points">
            <span class="custom-badge">Custom</span>
        </div>
    `;
    return element;
}

function getCustomDueTimeText(date) {
    const hours = date.getHours();
    const mins = date.getMinutes();
    if (hours === 23 && mins === 59) return '';
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHour = hours % 12 || 12;
    return `${displayHour}:${mins.toString().padStart(2, '0')} ${ampm}`;
}

function getTimeEstimateClass(minutes) {
    const value = Number(minutes) || 0;
    if (value <= 15) return 'quick';
    if (value >= 45) return 'long';
    return 'medium';
}

function formatCustomDuration(minutes) {
    const value = Number(minutes) || 0;
    if (value <= 0) return '15 min';
    if (value < 60) return `${value} min`;
    const hours = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function adjustDayTotal(dayKey, delta) {
    const completion = document.querySelector(`.day-completion[data-day="${dayKey}"]`);
    if (!completion) return;
    const total = parseInt(completion.dataset.total || '0', 10);
    completion.dataset.total = Math.max(0, total + delta);
}

function adjustUpcomingCompletionTotal(delta) {
    const totalComp = document.getElementById('total-completion');
    if (!totalComp) return;
    const total = parseInt(totalComp.dataset.total || '0', 10);
    totalComp.dataset.total = Math.max(0, total + delta);
}

function adjustTotalTimeMinutes(delta) {
    const totalTimeEl = document.getElementById('total-time');
    if (!totalTimeEl) return;
    const current = parseInt(totalTimeEl.dataset.totalMinutes || '0', 10);
    totalTimeEl.dataset.totalMinutes = Math.max(0, current + delta);
}

function clearCustomAssignmentsDom() {
    document.querySelectorAll('.assignment-item.custom-assignment').forEach(el => el.remove());
}

function removeCustomAssignmentById(id) {
    const index = assignmentsCustomEntries.findIndex(entry => entry.id === id);
    if (index === -1) return;
    const [assignment] = assignmentsCustomEntries.splice(index, 1);
    saveCustomAssignmentsToStorage();
    removeCustomAssignmentDom(assignment);
    renderCustomAssignmentsList();
    if (typeof updateDayCompletions === 'function') {
        updateDayCompletions();
    }
    if (typeof showToast === 'function') {
        showToast('Custom assignment removed', 'info');
    }
}

function removeCustomAssignmentDom(assignment) {
    const element = document.querySelector(`.assignment-item.custom-assignment[data-id="${assignment.id}"]`);
    if (!element) return;
    const dayKey = element.dataset.day;
    element.remove();
    adjustDayTotal(dayKey, -1);
    adjustUpcomingCompletionTotal(-1);
    adjustTotalTimeMinutes(-(assignment.estimatedMinutes || 15));
    removeEmptyDayGroup(dayKey);
}

function removeEmptyDayGroup(dayKey) {
    const list = document.getElementById('upcoming-day-list');
    if (!list) return;
    const group = list.querySelector(`.day-group[data-day="${dayKey}"]`);
    if (!group) return;
    if (group.querySelector('.assignment-item')) return;
    group.remove();
}

function renderCustomAssignmentsList() {
    const container = document.getElementById('custom-assignments-list');
    if (!container) return;
    container.innerHTML = '';
    if (assignmentsCustomEntries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'custom-assignments-empty';
        empty.textContent = 'No custom assignments yet.';
        container.appendChild(empty);
        return;
    }

    assignmentsCustomEntries.forEach(assignment => {
        const row = document.createElement('div');
        row.className = 'custom-assignments-row';
        row.innerHTML = `
            <div>
                <strong>${escapeHtml(assignment.title)}</strong>
                <div class="custom-meta">${assignment.course ? escapeHtml(assignment.course) : 'Unassigned course'}</div>
            </div>
            <div class="custom-row-meta">
                <span>${formatCustomAssignmentDueSummary(assignment)}</span>
                <span>${formatCustomDuration(assignment.estimatedMinutes)} estimate</span>
                <button type="button" class="remove-custom" data-assign-id="${assignment.id}">Remove</button>
            </div>
        `;
        container.appendChild(row);
    });
}

function bindCustomListEvents() {
    const list = document.getElementById('custom-assignments-list');
    if (!list || list.dataset.listenerBound === '1') return;
    list.addEventListener('click', (event) => {
        const button = event.target.closest('.remove-custom');
        if (!button) return;
        const id = button.dataset.assignId;
        if (!id) return;
        removeCustomAssignmentById(id);
    });
    list.dataset.listenerBound = '1';
}

function formatCustomAssignmentDueSummary(assignment) {
    const info = getCustomDayKeyInfo(assignment);
    if (info.dueDate) {
        const dateText = info.dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeText = getCustomDueTimeText(info.dueDate);
        return `${dateText}${timeText ? ' · ' + timeText : ''}`;
    }
    return 'No due date';
}
