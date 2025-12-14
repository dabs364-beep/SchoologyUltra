// Grades page functionality

// Persisted edits/drops for official + custom rows
// Structure: { [sectionId]: { [assignmentId]: { grade?: number|null, max?: number|null, dropped?: boolean } } }
const gradeEdits = {};

// Custom assignments (kept compatible with existing cookie format)
const gradesCustomAssignments = {};
let customIdCounter = 1;

let activeEditRow = null;

// Stats rendering (overall + per section)
let overallStatsRaf = null;

function scheduleOverallStatsUpdate() {
    if (overallStatsRaf) return;
    overallStatsRaf = requestAnimationFrame(() => {
        overallStatsRaf = null;
        try { renderOverallGradeStats(); } catch (e) { /* non-fatal */ }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text === null || text === undefined ? '' : String(text);
    return div.innerHTML;
}

function toNumberOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function mean(nums) {
    if (!nums || nums.length === 0) return null;
    return nums.reduce((s, x) => s + x, 0) / nums.length;
}

function median(nums) {
    if (!nums || nums.length === 0) return null;
    const a = nums.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return (a.length % 2) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function stdDev(nums) {
    if (!nums || nums.length === 0) return null;
    if (nums.length === 1) return 0;
    const m = mean(nums);
    const v = nums.reduce((s, x) => s + Math.pow(x - m, 2), 0) / nums.length; // population std dev
    return Math.sqrt(v);
}

function linearRegressionSlope(xs, ys) {
    if (!xs || !ys || xs.length !== ys.length || xs.length < 2) return null;
    const n = xs.length;
    const xMean = xs.reduce((s, x) => s + x, 0) / n;
    const yMean = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - xMean;
        num += dx * (ys[i] - yMean);
        den += dx * dx;
    }
    if (den === 0) return 0;
    return num / den;
}

function formatPct(v, decimals = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
    return v.toFixed(decimals) + '%';
}

function formatSignedPct(v, decimals = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(decimals) + '%';
}

function pctToGpa(pct) {
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0;
    if (pct >= 93) return 4.0;
    if (pct >= 90) return 3.7;
    if (pct >= 87) return 3.3;
    if (pct >= 83) return 3.0;
    if (pct >= 80) return 2.7;
    if (pct >= 77) return 2.3;
    if (pct >= 73) return 2.0;
    if (pct >= 70) return 1.7;
    if (pct >= 67) return 1.3;
    if (pct >= 63) return 1.0;
    if (pct >= 60) return 0.7;
    return 0;
}

const MIN_VALID_EPOCH_MS = 946684800000; // 2000-01-01; filters out 0/placeholder timestamps

function getRowTimeMs(row) {
    // Prefer API "graded" timestamp if present; otherwise use due timestamp.
    const graded = row?.dataset?.gradedTs !== undefined && row.dataset.gradedTs !== '' ? toNumberOrNull(row.dataset.gradedTs) : null;
    if (graded !== null && graded >= MIN_VALID_EPOCH_MS) return graded;
    const due = row?.dataset?.dueTs !== undefined && row.dataset.dueTs !== '' ? toNumberOrNull(row.dataset.dueTs) : null;
    if (due !== null && due >= MIN_VALID_EPOCH_MS) return due;
    return null;
}

function isLikelyEpochMs(x) {
    // Epoch ms is currently ~1.7e12; use a generous lower bound.
    return Number.isFinite(x) && x > 1000 * 1000 * 1000 * 10;
}

function formatShortDate(ms) {
    try {
        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
        return '';
    }
}

function getAssignmentNameFromRow(row) {
    try {
        const td = row ? row.querySelector('.assignment-name') : null;
        if (!td) return 'Assignment';
        // Prefer the first text node (avoids including the CUSTOM badge text).
        const firstTextNode = Array.from(td.childNodes).find(n => n.nodeType === Node.TEXT_NODE && String(n.textContent).trim() !== '');
        const raw = (firstTextNode ? firstTextNode.textContent : td.textContent) || '';
        return String(raw).replace(/\s+/g, ' ').trim() || 'Assignment';
    } catch (e) {
        return 'Assignment';
    }
}

function getCategoryNameFromRow(row) {
    try {
        const catSection = row ? row.closest('.category-section') : null;
        const titleEl = catSection ? catSection.querySelector('.category-title') : null;
        const t = titleEl ? titleEl.textContent : '';
        return String(t || '').replace(/\s+/g, ' ').trim() || 'Category';
    } catch (e) {
        return 'Category';
    }
}

function buildAssignmentTooltip(row, courseCard, grade, max) {
    const assignmentName = getAssignmentNameFromRow(row);
    const categoryName = getCategoryNameFromRow(row);
    const courseName = (courseCard && courseCard.dataset && courseCard.dataset.courseName)
        ? courseCard.dataset.courseName
        : (courseCard?.querySelector('.course-info h2')?.textContent || 'Course');

    let gradeLine = '';
    if (grade === null || max === null) {
        gradeLine = 'Grade: N/A';
    } else if (max > 0) {
        const pct = (grade / max) * 100;
        gradeLine = 'Grade: ' + grade + '/' + max + (Number.isFinite(pct) ? (' (' + pct.toFixed(2) + '%)') : '');
    } else if (max === 0) {
        gradeLine = 'Grade: +' + grade + ' (extra credit)';
    } else {
        gradeLine = 'Grade: ' + grade + '/' + max;
    }

    return courseName + '\n' + categoryName + ' • ' + assignmentName + '\n' + gradeLine;
}

function buildAssignmentMeta(row, courseCard, grade, max) {
    const assignmentName = getAssignmentNameFromRow(row);
    const categoryName = getCategoryNameFromRow(row);
    const courseName = (courseCard && courseCard.dataset && courseCard.dataset.courseName)
        ? courseCard.dataset.courseName
        : (courseCard?.querySelector('.course-info h2')?.textContent || 'Course');

    const dropped = !!(row && row.classList && row.classList.contains('dropped'));
    const tooltip = buildAssignmentTooltip(row, courseCard, grade, max);

    return {
        courseName,
        categoryName,
        assignmentName,
        grade,
        max,
        dropped,
        tooltip
    };
}

function computeRunningMeanSeries(rows) {
    const items = [];
    rows.forEach((row, idx) => {
        if (!row) return;
        if (row.classList.contains('dropped')) return;

        const { grade, max } = getRowNumbers(row);
        if (grade === null || max === null) return;
        if (max <= 0) return; // ignore extra credit (0) and invalid

        const pct = (grade / max) * 100;
        if (!Number.isFinite(pct)) return;

        const ts = getRowTimeMs(row);
        // If no usable timestamp, fall back to row order so the point still exists.
        const x = (ts !== null) ? ts : idx;

        items.push({ x, pct });
    });

    // If most timestamps are real (ms), ordering is meaningful; if some are indices, they still sort last/first consistently.
    items.sort((a, b) => a.x - b.x);

    const points = [];
    let sum = 0;
    let count = 0;
    for (const it of items) {
        sum += it.pct;
        count++;
        points.push({ x: it.x, y: sum / count, pct: it.pct, n: count });
    }

    return points;
}

function computeSectionGradeEvents(sectionId) {
    const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (!courseCard) return [];

    const categorySections = Array.from(courseCard.querySelectorAll('.category-section'));
    if (!categorySections.length) return [];

    const categories = categorySections.map((catSection, idx) => {
        const weight = parseFloat(catSection.dataset.weight) || 0;
        const rows = Array.from(catSection.querySelectorAll('tr.grade-row'));
        return {
            index: idx,
            weight,
            rows,
            earned: 0,
            max: 0
        };
    });

    const weightedMode = categories.some(c => c.weight > 0);

    // Build a chronological list of assignment events (every row is a point).
    const events = [];
    let tsCount = 0;
    let minTs = null;
    let maxTs = null;
    let fallbackIndex = 0;

    categories.forEach((cat, catIdx) => {
        cat.rows.forEach(row => {
            if (!row) return;
            const dropped = row.classList.contains('dropped');

            const n = getRowNumbers(row);
            const grade = n.grade;
            const max = n.max;

            // Every row should get a point. Only some rows affect the grade.
            const affectsGrade = !dropped && grade !== null && max !== null && max >= 0;

            const ts = getRowTimeMs(row);
            if (ts !== null) {
                tsCount++;
                minTs = (minTs === null) ? ts : Math.min(minTs, ts);
                maxTs = (maxTs === null) ? ts : Math.max(maxTs, ts);
            }

            events.push({ x: null, ts, fallbackIndex, row, catIdx, grade, max, affectsGrade });
            fallbackIndex++;
        });
    });

    // X-axis fallback:
    // - If we have <2 real timestamps (or no range), use stable index order for everyone.
    // - Otherwise, keep real timestamps, and spread missing-timestamp rows across the observed range
    //   by their stable row order so points don't pile up at the far right.
    const hasUsableTimeRange = (tsCount >= 2) && (minTs !== null) && (maxTs !== null) && (maxTs > minTs);
    const maxIdx = Math.max(1, fallbackIndex - 1);
    events.forEach(ev => {
        if (hasUsableTimeRange) {
            if (ev.ts !== null) ev.x = ev.ts;
            else ev.x = minTs + (ev.fallbackIndex / maxIdx) * (maxTs - minTs);
        } else {
            ev.x = ev.fallbackIndex;
        }
    });

    events.sort((a, b) => a.x - b.x);

    const out = [];
    for (const ev of events) {
        const cat = categories[ev.catIdx];
        if (!cat) continue;

        if (ev.affectsGrade) {
            // max === 0 => extra credit: include earned, but not max
            if (ev.max > 0) {
                cat.earned += ev.grade;
                cat.max += ev.max;
            } else if (ev.max === 0) {
                cat.earned += ev.grade;
            }
        }

        // Compute the current section grade using the same rules as recalculateAllGrades().
        let sectionPct = 0;
        let sumNewContrib = 0;

        if (weightedMode) {
            const totalActiveWeight = categories.reduce((s, c) => s + (c.weight > 0 && c.max > 0 ? c.weight : 0), 0);
            if (totalActiveWeight > 0) {
                categories.forEach(c => {
                    if (!(c.weight > 0 && c.max > 0)) return;
                    const pct = (c.earned / c.max) * 100;
                    if (!Number.isFinite(pct)) return;
                    sumNewContrib += pct * (c.weight / totalActiveWeight);
                });
            }
        }

        // If not weighted mode, or weighted mode has no active weighted categories, fall back to points-based.
        if (!weightedMode || sumNewContrib === 0) {
            const sectionMax = categories.reduce((s, c) => s + (c.max > 0 ? c.max : 0), 0);
            if (sectionMax > 0) {
                const sectionEarned = categories.reduce((s, c) => s + (Number.isFinite(c.earned) ? c.earned : 0), 0);
                sectionPct = (sectionEarned / sectionMax) * 100;
            } else {
                sectionPct = 0;
            }
        } else {
            sectionPct = sumNewContrib;
        }

        if (Number.isFinite(sectionPct)) {
            out.push({
                x: ev.x,
                y: sectionPct,
                meta: buildAssignmentMeta(ev.row, courseCard, ev.grade, ev.max)
            });
        }
    }

    return out;
}

function computeSectionGradeSeries(sectionId) {
    return computeSectionGradeEvents(sectionId).map(p => ({
        x: p.x,
        y: p.y,
        tooltip: p.meta?.tooltip,
        assignmentName: p.meta?.assignmentName,
        categoryName: p.meta?.categoryName,
        courseName: p.meta?.courseName,
        grade: p.meta?.grade,
        max: p.meta?.max,
        dropped: p.meta?.dropped
    }));
}

function computeOverallMeanSectionGradeSeries() {
    const courseCards = Array.from(document.querySelectorAll('.course-card[data-section]'));
    const perSectionEvents = courseCards
        .map(card => {
            const sectionId = card.dataset.section;
            const series = sectionId ? computeSectionGradeEvents(sectionId) : [];
            return { sectionId, series };
        })
        .filter(s => s.sectionId && s.series && s.series.length);

    if (!perSectionEvents.length) return [];

    // Merge all section events so the overall chart has a point per assignment event.
    const merged = [];
    perSectionEvents.forEach(s => {
        s.series.forEach(p => merged.push({
            sectionId: s.sectionId,
            x: p.x,
            y: p.y,
            meta: p.meta
        }));
    });
    merged.sort((a, b) => a.x - b.x);

    // Keep latest grade per section to compute mean after each event.
    const latest = new Map();
    const points = [];

    for (const ev of merged) {
        latest.set(ev.sectionId, ev.y);
        let sum = 0;
        let count = 0;
        latest.forEach(v => {
            if (v !== null && Number.isFinite(v)) {
                sum += v;
                count++;
            }
        });

        if (count > 0) {
            points.push({
                x: ev.x,
                y: sum / count,
                tooltip: ev.meta?.tooltip,
                assignmentName: ev.meta?.assignmentName,
                categoryName: ev.meta?.categoryName,
                courseName: ev.meta?.courseName,
                grade: ev.meta?.grade,
                max: ev.meta?.max,
                dropped: ev.meta?.dropped
            });
        }
    }

    return points;
}

function renderMeanOverTimeChart(containerEl, points, ariaLabel, options = {}) {
    if (!containerEl) return;
    if (!points || points.length === 0) {
        containerEl.innerHTML = '<div class="muted">No graded assignments yet.</div>';
        return;
    }

    const width = 640;
    const height = 180;
    const padLeft = 32;
    const padRight = 12;
    const padTop = 16;
    const padBottom = 18;

    points.forEach((p, idx) => { p.__graphIndex = idx; });
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);

    let xMin = Math.min(...xs);
    let xMax = Math.max(...xs);
    const earliestDueMs = options.timelineStartMs ?? null;
    const latestBoundMs = options.timelineEndMs ?? Date.now();
    const hasEpochTime = xs.some(v => isLikelyEpochMs(v));
    if (earliestDueMs !== null && Number.isFinite(earliestDueMs) && hasEpochTime) {
        xMin = Math.min(xMin, earliestDueMs);
    }
    if (latestBoundMs !== null && Number.isFinite(latestBoundMs) && hasEpochTime) {
        xMax = Math.max(xMax, latestBoundMs);
    }
    if (xMin === xMax) xMax = xMin + 1;

    const gradeMin = Math.min(...ys);
    const gradeMax = Math.max(...ys);
    let yMin = Number.isFinite(gradeMin) ? gradeMin - 5 : 0;
    if (!Number.isFinite(yMin)) yMin = 0;
    let yMax = Math.max(gradeMax, 100);
    if (yMin < 0) yMin = 0;
    const span = yMax - yMin;
    // Ensure at least a small padding so flat lines remain visible.
    if (span < 20) {
        const mid = (yMax + yMin) / 2;
        yMin = Math.max(0, mid - 10);
        yMax = Math.min(100, mid + 10);
        if (yMin === 0 && yMax - yMin < 20) {
            yMax = yMin + 20;
        }
    }
    if (yMin === yMax) {
        yMin -= 1;
        yMax += 1;
    } else {
        const padY = (yMax - yMin) * 0.08;
        yMin = Math.max(0, yMin - padY);
        yMax += padY;
    }

    const xSpan = xMax - xMin;
    const xRange = xSpan === 0 ? 1 : xSpan;
    const yRange = Math.max(0.1, yMax - yMin);
    const xScale = (x) => padLeft + ((x - xMin) / xRange) * (width - padLeft - padRight);
    const yScale = (y) => (height - padBottom) - ((y - yMin) / yRange) * (height - padTop - padBottom);

    const d = points
        .map((p, i) => (i === 0 ? 'M' : 'L') + xScale(p.x).toFixed(2) + ' ' + yScale(p.y).toFixed(2))
        .join(' ');

    const bottomY = height - padBottom;
    const circles = points
            .map(p => {
                const cx = xScale(p.x).toFixed(2);
                const cy = yScale(p.y).toFixed(2);
                const tip = p && p.tooltip ? String(p.tooltip) : null;
                return (
                    '<g data-index="' + p.__graphIndex + '">' +
                        '<circle class="grade-stats-point" data-index="' + p.__graphIndex + '" cx="' + cx + '" cy="' + cy + '" r="3.2" fill="var(--accent-primary)" opacity="0.95" />' +
                        (tip ? ('<title>' + escapeHtml(tip) + '</title>') : '') +
                    '</g>'
                );
            })
            .join('');

    const areaPath = [];
    if (points.length) {
        areaPath.push('M ' + xScale(points[0].x).toFixed(2) + ' ' + bottomY.toFixed(2));
        areaPath.push('L ' + xScale(points[0].x).toFixed(2) + ' ' + yScale(points[0].y).toFixed(2));
        for (let i = 1; i < points.length; i++) {
            areaPath.push('L ' + xScale(points[i].x).toFixed(2) + ' ' + yScale(points[i].y).toFixed(2));
        }
        areaPath.push('L ' + xScale(points[points.length - 1].x).toFixed(2) + ' ' + bottomY.toFixed(2));
        areaPath.push('Z');
    }

    // Minimal axis labels: y min/mid/max, and x start/end when timestamps.
    const yTicks = [yMax, (yMin + yMax) / 2, yMin];
    const yLabelX = 6;
    const yLabels = yTicks
        .map(v => {
            const y = yScale(v).toFixed(2);
            const labelText = Number.isFinite(v) ? (v.toFixed(0) + '%') : '';
            return (
                '<g>' +
                        '<line x1="' + padLeft + '" y1="' + y + '" x2="' + (width - padRight) + '" y2="' + y + '" stroke="var(--border-medium)" stroke-width="1" opacity="0.35" />' +
                        '<text x="' + yLabelX + '" y="' + (Number(y) - 2) + '" font-size="10" fill="var(--text-tertiary)" text-anchor="start">' + escapeHtml(labelText) + '</text>' +
                '</g>'
            );
        })
        .join('');

    const xIsMs = isLikelyEpochMs(xMin) && isLikelyEpochMs(xMax);
    const xStart = xIsMs ? formatShortDate(xMin) : '';
    const xEnd = xIsMs ? formatShortDate(xMax) : '';
    const xLabels = xIsMs
        ? (
            '<text x="' + padLeft + '" y="' + (height - 2) + '" font-size="10" fill="var(--text-tertiary)">' + escapeHtml(xStart) + '</text>' +
            '<text x="' + (width - padRight) + '" y="' + (height - 2) + '" font-size="10" fill="var(--text-tertiary)" text-anchor="end">' + escapeHtml(xEnd) + '</text>'
        )
        : '';

    const label = ariaLabel ? String(ariaLabel) : 'Grade over time';

    containerEl.innerHTML =
        '<svg class="grade-stats-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + escapeHtml(label) + '">' +
            yLabels +
            (areaPath.length ? ('<path class="grade-stats-area" d="' + areaPath.join(' ') + '" />') : '') +
            '<path d="' + d + '" fill="none" stroke="var(--accent-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9" />' +
            circles +
            // hover dotted line
            '<line class="chart-hover-line" x1="0" y1="' + padTop + '" x2="0" y2="' + (height - padBottom) + '" stroke="var(--text-tertiary)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.9" style="display:none;" />' +
            // selected assignment solid line (bottom up to point)
            '<line class="chart-selected-line" x1="0" y1="' + (height - padBottom) + '" x2="0" y2="' + (height - padBottom) + '" stroke="var(--accent-primary)" stroke-width="2" opacity="0.85" style="display:none;" />' +
            xLabels +
        '</svg>';

    // Hover UI: dotted line at cursor, and solid line to nearest assignment point.
    try {
        const svg = containerEl.querySelector('svg.grade-stats-svg');
        if (!svg) return;

        let tip = containerEl.querySelector('.grade-stats-hover-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'grade-stats-hover-tip';
            containerEl.appendChild(tip);
        }

        const hoverLine = svg.querySelector('.chart-hover-line');
        const selectedLine = svg.querySelector('.chart-selected-line');
        let activeCircle = null;

        const pts = points.slice().sort((a, b) => a.x - b.x);
        const xsSorted = pts.map(p => p.x);

        function nearestIndex(xVal) {
            // binary search for insertion index
            let lo = 0;
            let hi = xsSorted.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (xsSorted[mid] < xVal) lo = mid + 1;
                else hi = mid;
            }
            if (lo <= 0) return 0;
            if (lo >= xsSorted.length) return xsSorted.length - 1;
            const left = lo - 1;
            const right = lo;
            return (Math.abs(xsSorted[left] - xVal) <= Math.abs(xsSorted[right] - xVal)) ? left : right;
        }

        function interpolateY(xVal) {
            if (!pts.length) return null;
            if (xVal <= pts[0].x) return pts[0].y;
            if (xVal >= pts[pts.length - 1].x) return pts[pts.length - 1].y;

            let i = nearestIndex(xVal);
            // Ensure we have a bracket [i, i+1] where pts[i].x <= xVal <= pts[i+1].x
            if (pts[i].x > xVal) i = Math.max(0, i - 1);
            const j = Math.min(pts.length - 1, i + 1);
            if (i === j) return pts[i].y;
            const x0 = pts[i].x;
            const x1 = pts[j].x;
            const y0 = pts[i].y;
            const y1 = pts[j].y;
            if (x1 === x0) return y1;
            const t = (xVal - x0) / (x1 - x0);
            return y0 + (y1 - y0) * t;
        }

        function show() {
            if (hoverLine) hoverLine.style.display = '';
            if (selectedLine) selectedLine.style.display = '';
            if (tip) tip.style.display = 'block';
        }

        function hide() {
            if (hoverLine) hoverLine.style.display = 'none';
            if (selectedLine) selectedLine.style.display = 'none';
            if (tip) tip.style.display = 'none';
            if (activeCircle) {
                const original = activeCircle.dataset.originalRadius || '3.2';
                activeCircle.setAttribute('r', original);
                activeCircle.classList.remove('active');
                activeCircle = null;
            }
        }

        function onMove(e) {
            const rect = svg.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const relX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            const xVal = xMin + relX * (xMax - xMin);

            const yVal = interpolateY(xVal);
            const nearest = nearestIndex(xVal);
            const p = pts[nearest];

            const xPx = xScale(xVal);
            if (hoverLine) {
                hoverLine.setAttribute('x1', String(xPx));
                hoverLine.setAttribute('x2', String(xPx));
            }

            if (p && selectedLine) {
                const px = xScale(p.x);
                const py = yScale(p.y);
                selectedLine.setAttribute('x1', String(px));
                selectedLine.setAttribute('x2', String(px));
                selectedLine.setAttribute('y2', String(py));
            }

            const timeLabel = (xIsMs && isLikelyEpochMs(xVal)) ? formatShortDate(xVal) : '';
            const pctLabel = (yVal !== null && Number.isFinite(yVal)) ? (yVal.toFixed(2) + '%') : 'N/A';

            let closestLine = 'Closest: N/A';
            if (p) {
                const name = p.assignmentName || 'Assignment';
                const cat = p.categoryName || 'Category';
                const course = p.courseName || '';
                const g = p.grade;
                const m = p.max;
                let gm = 'Grade: N/A';
                if (g !== null && g !== undefined && m !== null && m !== undefined) {
                    if (m > 0) {
                        const pp = (g / m) * 100;
                        gm = 'Grade: ' + g + '/' + m + (Number.isFinite(pp) ? (' (' + pp.toFixed(2) + '%)') : '');
                    } else if (m === 0) {
                        gm = 'Grade: +' + g + ' (extra credit)';
                    } else {
                        gm = 'Grade: ' + g + '/' + m;
                    }
                }
                closestLine = 'Closest: ' + (course ? (course + ' • ') : '') + cat + ' • ' + name + (p.dropped ? ' (dropped)' : '') + ' — ' + gm;
            }

            tip.textContent = (timeLabel ? (timeLabel + ' • ') : '') + pctLabel + '\n' + closestLine;
            show();
            if (activeCircle) {
                const original = activeCircle.dataset.originalRadius || '3.2';
                activeCircle.setAttribute('r', original);
                activeCircle.classList.remove('active');
                activeCircle = null;
            }
            if (p) {
                const circleIdx = p.__graphIndex;
                const circleEl = svg.querySelector('circle.grade-stats-point[data-index="' + circleIdx + '"]');
                if (circleEl) {
                    const baseRadius = circleEl.getAttribute('r') || '3.2';
                    circleEl.dataset.originalRadius = circleEl.dataset.originalRadius || baseRadius;
                    circleEl.setAttribute('r', (Number(baseRadius) + 1).toFixed(1));
                    circleEl.classList.add('active');
                    activeCircle = circleEl;
                }
            }
        }

        svg.addEventListener('mouseenter', show);
        svg.addEventListener('mouseleave', hide);
        svg.addEventListener('mousemove', onMove);
        hide();
    } catch (e) {
        // non-fatal
    }
}

function pickTrendLabel(slope, unitLabel) {
    if (slope === null || !Number.isFinite(slope)) return { label: 'N/A', detail: '' };
    const unit = unitLabel || 'day';
    // Thresholds tuned to avoid noisy flips
    if (slope > 0.25) return { label: 'Rising', detail: formatSignedPct(slope, 2) + '/' + unit };
    if (slope < -0.25) return { label: 'Falling', detail: formatSignedPct(slope, 2) + '/' + unit };
    return { label: 'Flat', detail: formatSignedPct(slope, 2) + '/' + unit };
}

function computeSectionAssignmentStats(sectionId) {
    const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (!courseCard) return null;

    const rows = Array.from(courseCard.querySelectorAll('tr.grade-row[data-section="' + sectionId + '"]'));

    let droppedCount = 0;
    let ungradedCount = 0;
    let extraCreditPoints = 0;

    const pcts = [];
    const xs = [];
    const ys = [];

    // For trend: prefer due timestamps; otherwise use row order.
    // Use days as x-axis to make the slope interpretable.
    const now = Date.now();
    let hasAnyDueTs = false;
    rows.forEach((row, idx) => {
        const dropped = row.classList.contains('dropped');
        if (dropped) {
            droppedCount++;
            return;
        }

        const { grade, max } = getRowNumbers(row);
        if (grade === null || max === null) {
            ungradedCount++;
            return;
        }
        if (max === 0) {
            // extra credit
            extraCreditPoints += grade;
            return;
        }
        if (max < 0) return;
        if (max === 0) return;

        const pct = (max > 0) ? (grade / max) * 100 : null;
        if (pct === null || !Number.isFinite(pct)) return;
        pcts.push(pct);

        const dueTsRaw = row.dataset.dueTs;
        const dueTs = dueTsRaw !== undefined && dueTsRaw !== '' ? toNumberOrNull(dueTsRaw) : null;
        if (dueTs !== null) hasAnyDueTs = true;

        const xDays = (dueTs !== null ? (dueTs - now) : idx) / (24 * 60 * 60 * 1000);
        xs.push(xDays);
        ys.push(pct);
    });

    // If no due timestamps exist, re-map x to sequential 0..n-1 in days.
    if (!hasAnyDueTs && xs.length >= 2) {
        for (let i = 0; i < xs.length; i++) xs[i] = i;
    }

    const avg = mean(pcts);
    const med = median(pcts);
    const sd = stdDev(pcts);

    const last5 = pcts.slice(-5);
    const last5Avg = mean(last5);

    // Slope is % per day (or % per assignment when no due dates)
    const slope = (xs.length >= 2) ? linearRegressionSlope(xs, ys) : null;
    const trend = pickTrendLabel(slope, hasAnyDueTs ? 'day' : 'assignment');

    // Simple streak: compare last 3 average vs previous 3
    let momentum = 'N/A';
    if (pcts.length >= 6) {
        const tail = pcts.slice(-3);
        const prev = pcts.slice(-6, -3);
        const delta = mean(tail) - mean(prev);
        momentum = formatSignedPct(delta, 2);
    }

    // Consistency score: 100 - stddev, clamped
    let consistency = null;
    if (sd !== null) {
        consistency = Math.max(0, Math.min(100, 100 - sd));
    }

    return {
        count: pcts.length,
        droppedCount,
        ungradedCount,
        extraCreditPoints,
        mean: avg,
        median: med,
        stdDev: sd,
        last5Avg,
        slope,
        trend,
        momentum,
        consistency
    };
}

function renderSectionGradeStats(sectionId) {
    const box = document.getElementById('section-grade-stats-' + sectionId);
    if (!box) return;

    const courseCard = document.querySelector('.course-card[data-section="' + sectionId + '"]');
    if (!courseCard) return;

    const stats = computeSectionAssignmentStats(sectionId);
    if (!stats) return;

    const computedPct = toNumberOrNull(courseCard.dataset.computedPct);
    const originalPct = toNumberOrNull(courseCard.dataset.originalPct);
    const deltaPct = (computedPct !== null && originalPct !== null) ? (computedPct - originalPct) : null;

    const title = courseCard.dataset.courseName || courseCard.querySelector('.course-info h2')?.textContent || 'Section';
    const trendText = stats.trend.label + (stats.trend.detail ? ' (' + stats.trend.detail + ')' : '');

    box.innerHTML =
        '<div class="grade-stats-header">' +
            '<div class="grade-stats-title">' + escapeHtml(title) + ' • Statistics</div>' +
            '<div class="grade-stats-chip">' +
                (computedPct !== null ? (formatPct(computedPct) + ' ' + getLetterGrade(computedPct)) : 'N/A') +
                (deltaPct !== null ? (' • ' + formatSignedPct(deltaPct)) : '') +
            '</div>' +
        '</div>' +
        '<div class="grade-stats-grid">' +
            '<div class="grade-stats-metric"><div class="k">Mean</div><div class="v">' + formatPct(stats.mean) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Median</div><div class="v">' + formatPct(stats.median) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Std dev</div><div class="v">' + (stats.stdDev !== null ? stats.stdDev.toFixed(2) : 'N/A') + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Last 5 avg</div><div class="v">' + formatPct(stats.last5Avg) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Trend</div><div class="v">' + escapeHtml(trendText) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Momentum</div><div class="v">' + escapeHtml(String(stats.momentum)) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Consistency</div><div class="v">' + (stats.consistency !== null ? stats.consistency.toFixed(0) + '/100' : 'N/A') + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Count</div><div class="v">' + stats.count + ' graded' + (stats.ungradedCount ? (' • ' + stats.ungradedCount + ' ungraded') : '') + (stats.droppedCount ? (' • ' + stats.droppedCount + ' dropped') : '') + '</div></div>' +
        '</div>' +
        '<div class="grade-stats-chart" id="section-grade-chart-' + sectionId + '"></div>';

    try {
        const rows = Array.from(courseCard.querySelectorAll('tr.grade-row[data-section="' + sectionId + '"]'));
        const series = computeSectionGradeSeries(sectionId);
        const dueTs = rows
            .map(row => row?.dataset?.dueTs)
            .map(toNumberOrNull)
            .filter(ts => ts !== null && ts >= MIN_VALID_EPOCH_MS);
        const earliestDue = dueTs.length ? Math.min(...dueTs) : null;
        const chartEl = document.getElementById('section-grade-chart-' + sectionId);
        renderMeanOverTimeChart(chartEl, series, 'Section grade over time', {
            timelineStartMs: earliestDue,
            timelineEndMs: Date.now()
        });
    } catch (e) {
        // non-fatal
    }

    return stats;
}

function renderOverallGradeStats() {
    const box = document.getElementById('overall-grade-stats');
    if (!box) return;

    const courseCards = Array.from(document.querySelectorAll('.course-card[data-section]'));
    const sectionPcts = [];
    const sectionDeltas = [];
    let totalEarned = 0;
    let totalMax = 0;

    let highestPct = null;
    let lowestPct = null;

    courseCards.forEach(card => {
        if (card.dataset.sectionHasGrade !== '1') return;
        const pct = toNumberOrNull(card.dataset.computedPct);
        if (pct !== null) {
            sectionPcts.push(pct);
            highestPct = highestPct === null ? pct : Math.max(highestPct, pct);
            lowestPct = lowestPct === null ? pct : Math.min(lowestPct, pct);
        }

        const orig = toNumberOrNull(card.dataset.originalPct);
        if (pct !== null && orig !== null) {
            const d = pct - orig;
            sectionDeltas.push(d);
        }

        const earned = toNumberOrNull(card.dataset.sectionEarned);
        const max = toNumberOrNull(card.dataset.sectionMax);
        if (earned !== null) totalEarned += earned;
        if (max !== null) totalMax += max;
    });

    const overallPointsPct = (totalMax > 0) ? (totalEarned / totalMax * 100) : null;
    const m = mean(sectionPcts);
    const med = median(sectionPcts);
    const sd = stdDev(sectionPcts);
    const deltaMean = mean(sectionDeltas);

    const roundedForGpa = sectionPcts.map(pct => Math.round(pct));
    const gpa = sectionPcts.length ? (roundedForGpa.reduce((sum, pct) => sum + pctToGpa(pct), 0) / sectionPcts.length) : null;
    const rangePct = (highestPct !== null && lowestPct !== null) ? (highestPct - lowestPct) : null;

    const gpaText = gpa !== null ? gpa.toFixed(2) + ' / 4.0' : 'N/A';
    const rangeText = rangePct !== null ? formatPct(rangePct) : 'N/A';

    box.innerHTML =
        '<div class="grade-stats-header">' +
            '<div class="grade-stats-title">Overall • Statistics</div>' +
            '<div class="grade-stats-chip">' + (overallPointsPct !== null ? ('Points-based: ' + formatPct(overallPointsPct)) : 'Points-based: N/A') + '</div>' +
        '</div>' +
        '<div class="grade-stats-grid">' +
            '<div class="grade-stats-metric"><div class="k">Mean section %</div><div class="v">' + formatPct(m) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Median section %</div><div class="v">' + formatPct(med) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Std dev</div><div class="v">' + (sd !== null ? sd.toFixed(2) : 'N/A') + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Avg change</div><div class="v">' + (deltaMean !== null ? formatSignedPct(deltaMean) : 'N/A') + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">GPA</div><div class="v">' + escapeHtml(gpaText) + '</div></div>' +
            '<div class="grade-stats-metric"><div class="k">Range</div><div class="v">' + escapeHtml(rangeText) + '</div></div>' +
        '</div>' +
            '<div class="grade-stats-chart" id="overall-grade-chart" style="display: none;"></div>';

    try {
            const overallChartEl = document.getElementById('overall-grade-chart');
            if (overallChartEl) overallChartEl.remove();
    } catch (e) {
        // non-fatal
    }

    const debugBox = document.getElementById('overall-grade-stats-debug');
    if (debugBox) {
        const totalSections = courseCards.length;
        const excludedSections = totalSections - sectionPcts.length;
        const deltaSample = sectionDeltas.length ? sectionDeltas.slice(-3).map(d => formatSignedPct(d)).join(', ') : 'N/A';
        const gpaSamples = sectionPcts.length ? sectionPcts.slice(0, Math.min(sectionPcts.length, 5)).map(pct => pctToGpa(pct).toFixed(1)).join(', ') + (sectionPcts.length > 5 ? '…' : '') : 'N/A';
        const rangeDetail = (highestPct !== null && lowestPct !== null) ? (highestPct.toFixed(2) + '% / ' + lowestPct.toFixed(2) + '%') : 'N/A';
        let debugHtml = '';
        debugHtml += '<div class="row"><div><strong>Overall stats debug</strong></div><div></div></div>';
        debugHtml += '<div class="row"><div class="muted">Sections counted</div><div>' + sectionPcts.length + ' of ' + totalSections + (excludedSections ? ' (excluded ' + excludedSections + ' N/A)' : '') + '</div></div>';
        debugHtml += '<div class="row"><div class="muted">Points total</div><div>' + totalEarned.toFixed(2) + '/' + totalMax.toFixed(2) + ' (' + formatPct(overallPointsPct) + ')</div></div>';
        debugHtml += '<div class="row"><div class="muted">Avg change datapoints</div><div>' + sectionDeltas.length + ' sections</div></div>';
        debugHtml += '<div class="row"><div class="muted">Recent deltas</div><div>' + escapeHtml(deltaSample) + '</div></div>';
        debugHtml += '<div class="row"><div class="muted">GPA contributions (first few)</div><div>' + escapeHtml(gpaSamples) + '</div></div>';
        debugHtml += '<div class="row"><div class="muted">Range detail</div><div>' + rangeDetail + '</div></div>';
        debugBox.innerHTML = debugHtml;
    }
}

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

        // Initial overall stats once sections have computed pcts
        scheduleOverallStatsUpdate();
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

    if (grade !== null && max === 0) {
        const pillHtml = '<span class="grade-pill status-extra">Extra Credit</span>';
        if (pill) {
            pill.outerHTML = pillHtml;
        } else {
            if (actions) actions.insertAdjacentHTML('beforebegin', pillHtml);
            else pctCell.insertAdjacentHTML('afterbegin', pillHtml);
        }
        if (actions && !actions.parentElement) pctCell.appendChild(actions);
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
    if (gradeSpan) {
        gradeSpan.textContent = scoreVal === null ? '-' : String(scoreVal);
    } else if (scoreVal !== null) {
        const gradeCell = activeEditRow.querySelector('.grade-value');
        if (gradeCell) {
            gradeCell.innerHTML = '<span class="grade-display">' + String(scoreVal) + '</span>';
        }
    }
    if (maxSpan) maxSpan.textContent = maxVal === null ? '-' : String(maxVal);
    else if (maxVal !== null) {
        const maxCell = activeEditRow.querySelector('.max-points');
        if (maxCell) {
            maxCell.innerHTML = '<span class="max-display">' + String(maxVal) + '</span>';
        }
    }

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
    row.dataset.gradedTs = String(Date.now());

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

            // detect edits on official rows (include previously ungraded entries getting a value)
            if (!isCustom) {
                const o2 = getRowOriginalNumbers(row);
                const n = getRowNumbers(row);
                const gradeDiff = (n.grade !== null && o2.grade !== null && Math.abs(n.grade - o2.grade) > 0.001);
                const maxDiff = (n.max !== null && o2.max !== null && Math.abs(n.max - o2.max) > 0.001);
                const gradeAdded = (n.grade !== null && o2.grade === null && row.dataset.kind === 'official');
                const maxAdded = (n.max !== null && o2.max === null && row.dataset.kind === 'official');
                if (gradeDiff || maxDiff || gradeAdded || maxAdded) {
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

    // Expose computed values for overall stats
    try {
        courseCard.dataset.computedPct = String(newSectionPct);
        courseCard.dataset.originalPct = (originalSectionPct !== null && Number.isFinite(originalSectionPct)) ? String(originalSectionPct) : '';
        courseCard.dataset.sectionEarned = String(newSectionEarned);
        courseCard.dataset.sectionMax = String(newSectionMax);
        const hasGrade = (newSectionMax > 0) || (weightedMode && sumNewContrib > 0);
        courseCard.dataset.sectionHasGrade = hasGrade ? '1' : '';
    } catch (e) {
        // non-fatal
    }

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

    // Render section stats box once so debug can reference it
    let sectionStats = null;
    try { sectionStats = renderSectionGradeStats(sectionId); } catch (e) { sectionStats = null; }

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

            if (sectionStats) {
                const trendDetail = sectionStats.trend.label + (sectionStats.trend.detail ? ' (' + sectionStats.trend.detail + ')' : '');
                const momentumText = sectionStats.momentum || 'N/A';
                const consistencyText = (sectionStats.consistency !== null) ? sectionStats.consistency.toFixed(0) + '/100' : 'N/A';
                html += '<hr style="opacity:0.1; border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: var(--space-2) 0;">';
                html += '<div class="row"><div><strong>Stats calc</strong> <span class="muted">current values used for the box</span></div><div></div></div>';
                html += '<div class="row"><div class="muted">Assignments included</div><div>' + sectionStats.count + '</div></div>';
                html += '<div class="row"><div class="muted">Mean</div><div>' + formatPct(sectionStats.mean) + '</div></div>';
                html += '<div class="row"><div class="muted">Median</div><div>' + formatPct(sectionStats.median) + '</div></div>';
                html += '<div class="row"><div class="muted">Std dev</div><div>' + (sectionStats.stdDev !== null ? sectionStats.stdDev.toFixed(2) + '%' : 'N/A') + '</div></div>';
                html += '<div class="row"><div class="muted">Last 5 avg</div><div>' + formatPct(sectionStats.last5Avg) + '</div></div>';
                html += '<div class="row"><div class="muted">Trend</div><div>' + escapeHtml(trendDetail) + '</div></div>';
                html += '<div class="row"><div class="muted">Momentum</div><div>' + escapeHtml(momentumText) + '</div></div>';
                html += '<div class="row"><div class="muted">Consistency</div><div>' + escapeHtml(consistencyText) + '</div></div>';
                html += '<div class="row"><div class="muted">Extra credit points</div><div>' + sectionStats.extraCreditPoints.toFixed(2) + '</div></div>';
                html += '<div class="row"><div class="muted">Ungraded</div><div>' + sectionStats.ungradedCount + '</div></div>';
                html += '<div class="row"><div class="muted">Dropped</div><div>' + sectionStats.droppedCount + '</div></div>';
            }

            debugEl.innerHTML = html;
        }
    }

    // Refresh overall stats box (section stats already rendered before debug)
    scheduleOverallStatsUpdate();
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
