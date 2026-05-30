// ── WorkTracker App ──────────────────────────────────────────────────────────

const api = window.electronAPI;

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  tasks: [],
  sessions: [],
  activeTaskId: null,
  activeSessionStart: null,
  currentFilter: 'all',
  currentPage: 'dashboard',
  timerInterval: null,
};

// ── Utilities ────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

function formatDurationShort(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const roundedMin = Math.round(ms / 60000);
  const h = Math.floor(roundedMin / 60);
  const m = roundedMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function getTaskTotalMs(taskId, forDate = null) {
  const sessions = state.sessions.filter(s => {
    if (s.taskId !== taskId) return false;
    if (forDate) return s.date === forDate;
    return true;
  });
  let total = sessions.reduce((acc, s) => acc + (s.duration || 0), 0);
  // Add current live time if this task is running
  if (state.activeTaskId === taskId && state.activeSessionStart) {
    total += Date.now() - state.activeSessionStart;
  }
  return total;
}

function getCategoryEmoji(cat) {
  const map = { work: '💼', meeting: '🗣️', design: '🎨', development: '💻', research: '🔍', admin: '📋', other: '📌' };
  return map[cat] || '📌';
}

function getTaskStatus(task) {
  if (state.activeTaskId === task.id) return 'running';
  if (task.status === 'completed') return 'completed';
  if (getTaskTotalMs(task.id) > 0) return 'paused';
  return 'idle';
}

// ── Persistence ──────────────────────────────────────────────────────────────
async function loadData() {
  const data = await api.loadData();
  state.tasks = data.tasks || [];
  state.sessions = data.sessions || [];
  // Restore active task if needed (shouldn't normally survive restart)
}

async function saveData() {
  await api.saveData({ tasks: state.tasks, sessions: state.sessions });
}

// ── Timer Logic ──────────────────────────────────────────────────────────────
function startTask(taskId) {
  // Stop current active task first
  if (state.activeTaskId && state.activeTaskId !== taskId) {
    stopCurrentSession(false);
  }

  // Don't start if already running
  if (state.activeTaskId === taskId) return;

  state.activeTaskId = taskId;
  state.activeSessionStart = Date.now();

  // Update task status
  const task = state.tasks.find(t => t.id === taskId);
  if (task) task.status = 'running';

  saveData();
  startTimerInterval();
  renderAll();
  showNotif(`Started: ${task?.name}`, 'info');
}

function pauseTask(taskId) {
  if (state.activeTaskId !== taskId) return;
  stopCurrentSession(false);
  renderAll();
  const task = state.tasks.find(t => t.id === taskId);
  showNotif(`Paused: ${task?.name}`, 'info');
}

function stopTask(taskId) {
  if (state.activeTaskId === taskId) {
    stopCurrentSession(true);
  } else {
    // Mark completed even if not running
    const task = state.tasks.find(t => t.id === taskId);
    if (task) task.status = 'completed';
    saveData();
  }
  renderAll();
  const task = state.tasks.find(t => t.id === taskId);
  showNotif(`Stopped: ${task?.name}`, 'success');
}

function stopCurrentSession(markCompleted) {
  if (!state.activeTaskId || !state.activeSessionStart) return;

  const duration = Date.now() - state.activeSessionStart;
  const task = state.tasks.find(t => t.id === state.activeTaskId);

  // Save session
  state.sessions.push({
    id: genId(),
    taskId: state.activeTaskId,
    taskName: task?.name || 'Unknown',
    date: todayStr(),
    startTime: new Date(state.activeSessionStart).toISOString(),
    endTime: new Date().toISOString(),
    duration,
  });

  if (task) task.status = markCompleted ? 'completed' : 'paused';

  state.activeTaskId = null;
  state.activeSessionStart = null;

  clearInterval(state.timerInterval);
  state.timerInterval = null;

  saveData();
}

function startTimerInterval() {
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    updateLiveTimer();
  }, 1000);
}

function updateLiveTimer() {
  if (!state.activeTaskId || !state.activeSessionStart) return;
  const elapsed = Date.now() - state.activeSessionStart;
  const totalMs = getTaskTotalMs(state.activeTaskId);

  // Update active timer display
  const display = document.getElementById('active-timer-display');
  if (display) display.textContent = formatDuration(totalMs);

  // Update task card time inline if visible
  const card = document.querySelector(`[data-task-id="${state.activeTaskId}"] .task-card-time`);
  if (card) {
    card.textContent = formatDuration(totalMs);
  }

  // Update dashboard stats
  updateDashboardStats();
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────
function addTask(name, category, notes) {
  const task = {
    id: genId(),
    name: name.trim(),
    category,
    notes: notes.trim(),
    status: 'idle',
    createdAt: new Date().toISOString(),
    date: todayStr(),
  };
  state.tasks.unshift(task);
  saveData();
  renderAll();
  showNotif(`Task added: ${task.name}`, 'success');
}

function deleteTask(taskId) {
  if (state.activeTaskId === taskId) {
    stopCurrentSession(false);
  }
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  state.sessions = state.sessions.filter(s => s.taskId !== taskId);
  saveData();
  renderAll();
  showNotif('Task deleted', 'info');
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  renderDashboard();
  renderTasksPage();
  renderActiveTimerCard();
  updateDashboardStats();
  if (state.currentPage === 'report') renderReport();
}

function renderActiveTimerCard() {
  const card = document.getElementById('active-timer-card');
  const nameEl = document.getElementById('active-timer-name');
  const displayEl = document.getElementById('active-timer-display');

  if (!state.activeTaskId) {
    card.style.display = 'none';
    return;
  }

  const task = state.tasks.find(t => t.id === state.activeTaskId);
  if (!task) { card.style.display = 'none'; return; }

  card.style.display = 'block';
  nameEl.textContent = `${getCategoryEmoji(task.category)} ${task.name}`;
  displayEl.textContent = formatDuration(getTaskTotalMs(task.id));
}

function createTaskCard(task) {
  const status = getTaskStatus(task);
  const totalMs = getTaskTotalMs(task.id);
  const isRunning = status === 'running';

  const div = document.createElement('div');
  div.className = `task-card${isRunning ? ' active-tracking' : ''}`;
  div.dataset.taskId = task.id;

  const dotClass = { running: 'running', paused: 'paused', completed: 'completed', idle: 'idle' }[status] || 'idle';

  div.innerHTML = `
    <div class="task-status-dot ${dotClass}"></div>
    <div class="task-card-info">
      <div class="task-card-name">${task.name}</div>
      <div class="task-card-meta">
        <span class="task-card-category">${getCategoryEmoji(task.category)} ${task.category}</span>
        ${task.notes ? `<span title="${task.notes}">📝 Note</span>` : ''}
        <span>${formatDate(task.createdAt)}</span>
      </div>
    </div>
    <div class="task-card-time ${isRunning ? 'running' : ''}">${formatDuration(totalMs)}</div>
    <div class="task-card-actions">
      ${!isRunning && status !== 'completed'
      ? `<button class="task-btn start" title="Start" data-action="start">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>
           </button>`
      : ''}
      ${isRunning
      ? `<button class="task-btn pause-btn" title="Pause" data-action="pause">
            <svg width="12" height="14" viewBox="0 0 12 14"><rect width="4" height="14" rx="2" fill="currentColor"/><rect x="8" width="4" height="14" rx="2" fill="currentColor"/></svg>
           </button>`
      : ''}
      ${(isRunning || status === 'paused')
      ? `<button class="task-btn stop-btn" title="Stop / Mark Complete" data-action="stop">
            <svg width="13" height="13" viewBox="0 0 13 13"><rect width="13" height="13" rx="2.5" fill="currentColor"/></svg>
           </button>`
      : ''}
      <button class="task-btn delete hidden" title="Delete task" data-action="delete">
        <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 3h9M5 3V2h3v1M5 6v4M8 6v4M3 3l.7 8h5.6L10 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>
      </button>
    </div>
  `;

  // Bind action buttons
  div.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'start') startTask(task.id);
      else if (action === 'pause') pauseTask(task.id);
      else if (action === 'stop') stopTask(task.id);
      else if (action === 'delete') confirmDelete(task);
    });
  });

  return div;
}

function renderDashboard() {
  const list = document.getElementById('dashboard-task-list');
  list.innerHTML = '';

  // Show today's tasks
  const todayTasks = state.tasks.filter(t => t.date === todayStr() || getTaskTotalMs(t.id, todayStr()) > 0);

  if (todayTasks.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="#ffffff15" stroke-width="2"/><path d="M24 16v8l4 4" stroke="#ffffff20" stroke-width="2" stroke-linecap="round"/></svg>
      <p>No tasks today. Add one to start tracking!</p>
    </div>`;
    return;
  }

  todayTasks.forEach(task => list.appendChild(createTaskCard(task)));
}

function renderTasksPage() {
  const list = document.getElementById('tasks-task-list');
  list.innerHTML = '';

  let tasks = [...state.tasks];

  // Filter
  if (state.currentFilter !== 'all') {
    tasks = tasks.filter(t => {
      const status = getTaskStatus(t);
      if (state.currentFilter === 'active') return status === 'running';
      if (state.currentFilter === 'paused') return status === 'paused';
      if (state.currentFilter === 'completed') return status === 'completed';
      return true;
    });
  }

  if (tasks.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="#ffffff15" stroke-width="2"/><path d="M16 24h16M16 17h16M16 31h10" stroke="#ffffff20" stroke-width="2" stroke-linecap="round"/></svg>
      <p>No tasks found.</p>
    </div>`;
    return;
  }

  tasks.forEach(task => list.appendChild(createTaskCard(task)));
}

function updateDashboardStats() {
  const today = todayStr();

  // Today's total hours
  let todayMs = 0;
  state.tasks.forEach(t => { todayMs += getTaskTotalMs(t.id, today); });
  // Add live time for active task
  const el = document.getElementById('sum-today-hours');
  if (el) el.textContent = formatDurationShort(todayMs);

  // Active task count
  const activeCnt = state.tasks.filter(t => getTaskStatus(t) !== 'completed').length;
  const sumTask = document.getElementById('sum-task-count');
  if (sumTask) sumTask.textContent = activeCnt;

  // Today sessions
  const todaySessions = state.sessions.filter(s => s.date === today).length;
  const sumSess = document.getElementById('sum-sessions');
  if (sumSess) sumSess.textContent = todaySessions;
}

// ── Report ────────────────────────────────────────────────────────────────────
function renderReport(dateStr) {
  const date = dateStr || document.getElementById('report-date')?.value || todayStr();

  // Group sessions by task
  const sessions = state.sessions.filter(s => s.date === date);

  // Build report rows per task
  const taskMap = {};
  sessions.forEach(s => {
    if (!taskMap[s.taskId]) {
      taskMap[s.taskId] = {
        name: s.taskName,
        sessions: [],
        totalMs: 0,
      };
    }
    taskMap[s.taskId].sessions.push(s);
    taskMap[s.taskId].totalMs += s.duration;
  });

  // Add currently running task
  if (state.activeTaskId && state.activeSessionStart) {
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    const todayDate = todayStr();
    if (task && date === todayDate) {
      if (!taskMap[state.activeTaskId]) {
        taskMap[state.activeTaskId] = { name: task.name, sessions: [], totalMs: 0 };
      }
      taskMap[state.activeTaskId].totalMs += Date.now() - state.activeSessionStart;
    }
  }

  const tbody = document.getElementById('report-tbody');
  tbody.innerHTML = '';

  let grandTotal = 0;
  const tasks = Object.entries(taskMap);

  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px">No sessions found for this date</td></tr>`;
  } else {
    tasks.forEach(([taskId, data]) => {
      grandTotal += data.totalMs;
      const firstSession = data.sessions[0];
      const lastSession = data.sessions[data.sessions.length - 1];
      const task = state.tasks.find(t => t.id === taskId);
      const status = task ? getTaskStatus(task) : 'completed';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${data.name}</strong></td>
        <td style="color:var(--text-secondary)">${data.sessions.length}</td>
        <td style="font-family:var(--font-mono);font-size:12px">${firstSession ? formatTime(firstSession.startTime) : '—'}</td>
        <td style="font-family:var(--font-mono);font-size:12px">${lastSession?.endTime ? formatTime(lastSession.endTime) : '🔴 Running'}</td>
        <td>${formatDurationShort(data.totalMs)}</td>
        <td><span class="badge ${status}">${status}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Total
  const totalEl = document.getElementById('report-total');
  totalEl.innerHTML = `
    <div class="report-total-label">Total Work Time — ${new Date(date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
    <div class="report-total-value">${formatDurationShort(grandTotal)}</div>
  `;

  // Summary cards
  const summaryEl = document.getElementById('report-summary');
  summaryEl.innerHTML = `
    <div class="summary-card">
      <div class="summary-icon" style="background:#7c6af720">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#7c6af7" stroke-width="1.5"/><path d="M10 6v4l2.5 2.5" stroke="#7c6af7" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value">${formatDurationShort(grandTotal)}</div>
        <div class="summary-label">Total Hours</div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-icon" style="background:#22d3ee20">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 15V8l6-5 6 5v7" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round"/><rect x="7" y="10" width="6" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value">${tasks.length}</div>
        <div class="summary-label">Tasks Worked</div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-icon" style="background:#f59e0b20">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v6l3 3" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="10" r="8" stroke="#f59e0b" stroke-width="1.5"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value" id="wake-time-value">—</div>
        <div class="summary-label">App Open Time</div>
      </div>
    </div>
  `;

  // Wake time calculation
  if (api.getAppStartTime) {
    api.getAppStartTime().then(appStart => {
      const diffMs = Date.now() - new Date(appStart);
      const diffMins = Math.floor(diffMs / 60000);
      const hours = Math.floor(diffMins / 60);
      const mins = diffMins % 60;
      const wakeEl = document.getElementById('wake-time-value');
      if (wakeEl) wakeEl.textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    });
  }
}

function generateReportText(date) {
  const d = date || document.getElementById('report-date')?.value || todayStr();
  const sessions = state.sessions.filter(s => s.date === d);

  const taskMap = {};
  sessions.forEach(s => {
    if (!taskMap[s.taskId]) taskMap[s.taskId] = { name: s.taskName, sessions: [], totalMs: 0 };
    taskMap[s.taskId].sessions.push(s);
    taskMap[s.taskId].totalMs += s.duration;
  });

  let text = `WorkTracker Report\n`;
  text += `Date: ${new Date(d).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
  text += `Generated: ${new Date().toLocaleString()}\n`;
  text += '═'.repeat(60) + '\n\n';

  let grandTotal = 0;
  Object.values(taskMap).forEach(data => {
    grandTotal += data.totalMs;
    const first = data.sessions[0];
    const last = data.sessions[data.sessions.length - 1];
    text += `Task: ${data.name}\n`;
    text += `  Sessions: ${data.sessions.length}\n`;
    if (first) text += `  Started: ${formatTime(first.startTime)}\n`;
    if (last?.endTime) text += `  Ended:   ${formatTime(last.endTime)}\n`;
    text += `  Time:     ${formatDurationShort(data.totalMs)}\n`;
    text += '─'.repeat(40) + '\n';
  });

  text += `\nTOTAL WORK TIME: ${formatDurationShort(grandTotal)}\n`;
  text += `TASKS WORKED: ${Object.keys(taskMap).length}\n`;
  text += `SESSIONS: ${sessions.length}\n`;

  return text;
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function showModal() {
  document.getElementById('task-name-input').value = '';
  document.getElementById('task-category-input').value = 'work';
  document.getElementById('task-notes-input').value = '';
  document.getElementById('modal-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('task-name-input').focus(), 50);
}

function hideModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

let confirmCallback = null;
function showConfirm(title, message, cb) {
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-overlay').style.display = 'flex';
  confirmCallback = cb;
}

function hideConfirm() {
  document.getElementById('confirm-overlay').style.display = 'none';
  confirmCallback = null;
}

function confirmDelete(task) {
  showConfirm('Delete Task', `Delete "${task.name}" and all its sessions? This cannot be undone.`, () => {
    deleteTask(task.id);
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function showNotif(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Navigation ────────────────────────────────────────────────────────────────
function switchPage(page) {
  state.currentPage = page;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

  if (page === 'report') renderReport();
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  const settings = await api.loadSettings();
  document.getElementById('toggle-startup').checked = settings.startWithWindows || false;

  if (settings.firebaseConfig) {
    document.getElementById('fb-api-key').value = settings.firebaseConfig.apiKey || '';
    document.getElementById('fb-project-id').value = settings.firebaseConfig.projectId || '';
    document.getElementById('fb-app-id').value = settings.firebaseConfig.appId || '';
  }

  const info = await api.getPlatformInfo();
  document.getElementById('platform-info').textContent = `${info.platform} — ${info.username}`;
}

// ── Date/Greeting ─────────────────────────────────────────────────────────────
function updateDateDisplay() {
  const now = new Date();
  const hour = now.getHours();

  let greet = 'Good morning';
  if (hour >= 12 && hour < 17) greet = 'Good afternoon';
  else if (hour >= 17) greet = 'Good evening';

  document.getElementById('greeting').textContent = `${greet}! Here's your work overview.`;

  const dateEl = document.getElementById('sidebar-date');
  if (dateEl) {
    dateEl.innerHTML = `${now.toLocaleDateString([], { weekday: 'long' })}<br>${now.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}`;
  }
}

// ── Export Report ─────────────────────────────────────────────────────────────
async function exportReport(format) {
  const date = document.getElementById('report-date').value;
  const content = generateReportText(date);
  const dateStr = date || new Date().toISOString().split('T')[0];

  if (format === 'txt') {
    const filepath = await api.exportReport({ content, filename: `worktracker-report-${dateStr}.txt` });
    showNotif(`Report saved: ${filepath}`, 'success');
  } else if (format === 'pdf') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 20;
    let y = margin;

    const checkPage = (needed = 10) => {
      if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
    };

    // ── Header bar
    doc.setFillColor(30, 20, 60);
    doc.rect(0, 0, pageW, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('WorkTracker Report', margin, 18);

    // Date top right
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    const d = date || todayStr();
    doc.text(new Date(d).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), pageW - margin, 18, { align: 'right' });

    y = 40;

    // ── Meta info
    doc.setTextColor(80, 80, 80);
    doc.setFontSize(9);
    doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
    y += 12;

    // ── Summary box
    const sessions = state.sessions.filter(s => s.date === d);
    const taskMap = {};
    sessions.forEach(s => {
      if (!taskMap[s.taskId]) taskMap[s.taskId] = { name: s.taskName, sessions: [], totalMs: 0 };
      taskMap[s.taskId].sessions.push(s);
      taskMap[s.taskId].totalMs += s.duration;
    });
    const grandTotal = Object.values(taskMap).reduce((a, t) => a + t.totalMs, 0);

    doc.setFillColor(245, 245, 255);
    doc.roundedRect(margin, y, pageW - margin * 2, 12, 3, 3, 'F');
    doc.setTextColor(60, 60, 60);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60, 60, 60);
    doc.text(`Total Work Time: ${formatDurationShort(grandTotal)}`, margin + 6, y + 8);
    doc.text(`Tasks: ${Object.keys(taskMap).length}`, pageW / 2, y + 8, { align: 'center' });
    doc.text(`Sessions: ${sessions.length}`, pageW - margin - 6, y + 8, { align: 'right' });
    y += 18;

    // ── Table header
    doc.setFillColor(124, 106, 247);
    doc.rect(margin, y, pageW - margin * 2, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const cols = [margin + 3, 90, 120, 148, 172];
    doc.text('TASK', cols[0], y + 5.5);
    doc.text('SESSIONS', cols[1], y + 5.5);
    doc.text('START', cols[2], y + 5.5);
    doc.text('END', cols[3], y + 5.5);
    doc.text('DURATION', cols[4], y + 5.5);
    y += 8;

    // ── Table rows
    let rowIndex = 0;
    Object.values(taskMap).forEach(data => {
      checkPage(10);
      if (rowIndex % 2 === 0) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, pageW - margin * 2, 9, 'F');
      }
      const first = data.sessions[0];
      const last = data.sessions[data.sessions.length - 1];
      doc.setTextColor(30, 30, 30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(data.name, cols[0], y + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(80, 80, 80);
      doc.text(String(data.sessions.length), cols[1], y + 6);
      doc.text(first ? formatTime(first.startTime) : '-', cols[2], y + 6);
      doc.text(last?.endTime ? formatTime(last.endTime) : 'Running', cols[3], y + 6);
      doc.setTextColor(100, 80, 220);
      doc.setFont('helvetica', 'bold');
      doc.text(formatDurationShort(data.totalMs), cols[4], y + 6);
      y += 9;
      rowIndex++;
    });

    // ── Footer line
    y += 6;
    checkPage(12);
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageW - margin, y);
    y += 8;
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.setFont('helvetica', 'normal');
    doc.text('Generated by WorkTracker', margin, y);
    doc.text(`Page 1`, pageW - margin, y, { align: 'right' });

    const pdfContent = doc.output('arraybuffer');
    const base64 = btoa(String.fromCharCode(...new Uint8Array(pdfContent)));
    const filepath = await api.exportReport({ content: base64, filename: `worktracker-report-${dateStr}.pdf`, isPdf: true });
    showNotif(`PDF saved: ${filepath}`, 'success');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadData();
  await loadSettings();

  // Set today's date in report
  document.getElementById('report-date').value = todayStr();

  updateDateDisplay();
  setInterval(updateDateDisplay, 60000);

  renderAll();

  // Navigation
  document.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => api.windowMinimize());
  document.getElementById('btn-maximize').addEventListener('click', () => api.windowMaximize());
  document.getElementById('btn-close').addEventListener('click', () => api.windowClose());

  // Add task buttons
  document.getElementById('btn-add-task-quick').addEventListener('click', showModal);
  document.getElementById('btn-add-task').addEventListener('click', showModal);

  // Modal
  document.getElementById('modal-close').addEventListener('click', hideModal);
  document.getElementById('btn-modal-cancel').addEventListener('click', hideModal);
  document.getElementById('btn-modal-save').addEventListener('click', () => {
    const name = document.getElementById('task-name-input').value.trim();
    if (!name) { showNotif('Please enter a task name', 'error'); return; }
    const cat = document.getElementById('task-category-input').value;
    const notes = document.getElementById('task-notes-input').value;
    addTask(name, cat, notes);
    hideModal();
  });

  document.getElementById('task-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-modal-save').click();
    if (e.key === 'Escape') hideModal();
  });

  // Confirm modal
  document.getElementById('btn-confirm-cancel').addEventListener('click', hideConfirm);
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    hideConfirm();
  });

  // Active timer controls
  document.getElementById('btn-pause-active').addEventListener('click', () => {
    if (state.activeTaskId) pauseTask(state.activeTaskId);
  });
  document.getElementById('btn-stop-active').addEventListener('click', () => {
    if (state.activeTaskId) stopTask(state.activeTaskId);
  });

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentFilter = btn.dataset.filter;
      renderTasksPage();
    });
  });

  // Report date picker
  document.getElementById('report-date').addEventListener('change', (e) => {
    renderReport(e.target.value);
  });

  // Export report
  document.getElementById('btn-export-report').addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = document.getElementById('export-dropdown');
    if (existing) { existing.remove(); return; }

    const dropdown = document.createElement('div');
    dropdown.id = 'export-dropdown';
    dropdown.style.cssText = `
    position:fixed; background:#1e1e2e; border:1px solid #ffffff15;
    border-radius:10px; padding:6px; z-index:9999; min-width:160px;
    box-shadow:0 8px 32px #0008;
  `;
    dropdown.innerHTML = `
    <button onclick="exportReport('txt')" style="display:block;width:100%;padding:10px 14px;background:none;border:none;color:#fff;text-align:left;cursor:pointer;border-radius:7px;font-size:13px;" onmouseover="this.style.background='#ffffff10'" onmouseout="this.style.background='none'">📄 Export as TXT</button>
    <button onclick="exportReport('pdf')" style="display:block;width:100%;padding:10px 14px;background:none;border:none;color:#fff;text-align:left;cursor:pointer;border-radius:7px;font-size:13px;" onmouseover="this.style.background='#ffffff10'" onmouseout="this.style.background='none'">📕 Export as PDF</button>
  `;

    const btn = document.getElementById('btn-export-report');
    const rect = btn.getBoundingClientRect();
    const fromRight = window.innerWidth - rect.right;
    dropdown.style.top = (rect.bottom + 8) + 'px';
    dropdown.style.right = fromRight + 'px';
    dropdown.style.left = 'auto';
    document.body.appendChild(dropdown);

    setTimeout(() => {
      document.addEventListener('click', () => dropdown.remove(), { once: true });
    }, 0);
  });

  // Settings
  document.getElementById('toggle-startup').addEventListener('change', async (e) => {
    const settings = await api.loadSettings();
    settings.startWithWindows = e.target.checked;
    await api.saveSettings(settings);
    showNotif(`Startup ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
  });

  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const content = JSON.stringify({ tasks: state.tasks, sessions: state.sessions }, null, 2);
    const filepath = await api.exportReport({ content, filename: `worktracker-backup-${todayStr()}.json` });
    showNotif(`Exported: ${filepath}`, 'success');
  });

  document.getElementById('btn-clear-today').addEventListener('click', () => {
    showConfirm('Clear Today', "Remove all today's sessions?", () => {
      state.sessions = state.sessions.filter(s => s.date !== todayStr());
      if (state.activeTaskId) { stopCurrentSession(false); }
      saveData();
      renderAll();
      showNotif("Today's data cleared", 'info');
    });
  });

  document.getElementById('btn-reset-all').addEventListener('click', () => {
    showConfirm('Reset All Data', 'Delete ALL tasks and sessions permanently?', () => {
      if (state.activeTaskId) { clearInterval(state.timerInterval); state.activeTaskId = null; state.activeSessionStart = null; }
      state.tasks = [];
      state.sessions = [];
      saveData();
      renderAll();
      showNotif('All data reset', 'info');
    });
  });

  document.getElementById('btn-save-firebase').addEventListener('click', async () => {
    const settings = await api.loadSettings();
    settings.firebaseConfig = {
      apiKey: document.getElementById('fb-api-key').value.trim(),
      projectId: document.getElementById('fb-project-id').value.trim(),
      appId: document.getElementById('fb-app-id').value.trim(),
    };
    await api.saveSettings(settings);
    showNotif('Firebase config saved (restart to activate)', 'success');
  });

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) hideModal();
  });
  document.getElementById('confirm-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('confirm-overlay')) hideConfirm();
  });
}

document.addEventListener('DOMContentLoaded', init);
