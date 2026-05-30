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
let selectedCountry = 'LK';

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
  // Load planner data
  plannerState.projects = data.projects || [];
  plannerState.versions = data.versions || [];
  plannerState.plannerTasks = data.plannerTasks || [];
  // Restore active task if needed (shouldn't normally survive restart)
}

async function saveData() {
  await api.saveData({
    tasks: state.tasks,
    sessions: state.sessions,
    projects: plannerState.projects,
    versions: plannerState.versions,
    plannerTasks: plannerState.plannerTasks,
  });
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

  renderDashboardProjects();
}

function renderDashboardProjects() {
  const grid = document.getElementById('dashboard-planner-projects');
  if (!grid) return;
  grid.innerHTML = '';

  if (plannerState.projects.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);font-size:13px;padding:12px 0">No projects yet. Go to Planner to create one.</div>`;
    return;
  }

  plannerState.projects.forEach(proj => {
    const versions = plannerState.versions.filter(v => v.projectId === proj.id);
    const taskCount = versions.reduce((acc, v) => acc + plannerState.plannerTasks.filter(t => t.versionId === v.id).length, 0);
    const div = document.createElement('div');
    div.className = 'planner-project-card';
    div.style.setProperty('--proj-color', proj.color || PLANNER_COLORS[0]);
    div.innerHTML = `
      <div class="proj-card-header">
        <div class="proj-card-icon" style="--proj-color:${proj.color}">📋</div>
      </div>
      <div class="proj-card-name">${proj.name}</div>
      <div class="proj-card-desc">${proj.desc || 'No description'}</div>
      <div class="proj-card-meta">
        <span class="proj-card-meta-item">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 5h10M4 1v2M8 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${versions.length} version${versions.length !== 1 ? 's' : ''}
        </span>
        <span class="proj-card-meta-item">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3.5h8M2 6h6M2 8.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${taskCount} task${taskCount !== 1 ? 's' : ''}
        </span>
      </div>`;
    div.addEventListener('click', () => {
      switchPage('planner');
      openProjectBoard(proj.id);
    });
    grid.appendChild(div);
  });
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
  if (page === 'calendar') renderCalendar().catch(console.error);
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

  if (settings.country) {
    selectedCountry = settings.country;
    document.getElementById('select-country').value = settings.country;
  }

  document.getElementById('select-country').addEventListener('change', async (e) => {
    selectedCountry = e.target.value;
    const settings = await api.loadSettings();
    settings.country = e.target.value;
    await api.saveSettings(settings);
    showNotif(`Holidays updated for ${e.target.options[e.target.selectedIndex].text}`, 'info');
    if (state.currentPage === 'calendar') renderCalendar().catch(console.error);
  });
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
    const filepath = await api.exportReport({ content, filename: `worktracker-report-${dateStr}.txt`, folder: 'Reports' });
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
    const filepath = await api.exportReport({ content: base64, filename: `worktracker-report-${dateStr}.pdf`, isPdf: true, folder: 'Reports' });
    showNotif(`PDF saved: ${filepath}`, 'success');
  }
}

// ── Holidays API ──────────────────────────────────────────────────────────────
let holidayCache = {}; // { 'LK-2026': { '05-01': 'Labour Day', ... } }

async function fetchHolidays(countryCode, year) {
  const cacheKey = `${countryCode}-${year}`;
  if (holidayCache[cacheKey]) return holidayCache[cacheKey];

  if (countryCode !== 'LK') return {};

  try {
    const url = `https://raw.githubusercontent.com/Dilshan-H/srilanka-holidays/main/json/${year}.json`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    data.forEach(h => {
      const monthDay = h.start.slice(5); // MM-DD
      map[monthDay] = h.summary;
    });
    holidayCache[cacheKey] = map;
    return map;
  } catch (e) {
    console.error('fetchHolidays error:', e);
    return {};
  }
}

// ── Calendar ──────────────────────────────────────────────────────────────────
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();


async function renderCalendar() {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  document.getElementById('cal-month-label').textContent = `${monthNames[calMonth]} ${calYear}`;

  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const todayStr2 = todayStr();

  // Fetch holidays for this month's year
  const holidays = await fetchHolidays(selectedCountry, calYear);

  // Build session map by date
  const dateMap = {};
  state.sessions.forEach(s => {
    if (!dateMap[s.date]) dateMap[s.date] = { totalMs: 0, tasks: new Set() };
    dateMap[s.date].totalMs += s.duration;
    dateMap[s.date].tasks.add(s.taskName);
  });

  let html = '<div class="cal-grid">';

  // Day headers
  dayNames.forEach(d => { html += `<div class="cal-day-header">${d}</div>`; });

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += `<div class="cal-day empty"></div>`;
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isToday = dateKey === todayStr2;
    const data = dateMap[dateKey];
    const hasWork = !!data;
    const holiday = holidays[dateKey.slice(5)]; // MM-DD lookup

    let taskPills = '';
    if (data) {
      const taskList = [...data.tasks].slice(0, 2);
      taskPills = taskList.map(t => `<div class="cal-task-pill">${t}</div>`).join('');
      if (data.tasks.size > 2) taskPills += `<div class="cal-task-pill">+${data.tasks.size - 2} more</div>`;
    }

    const dayOfWeek = new Date(dateKey).getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    html += `
      <div class="cal-day ${isToday ? 'today' : ''} ${hasWork ? 'has-work' : ''} ${holiday ? 'is-holiday' : ''} ${isWeekend ? 'weekend' : ''}"
           onclick="switchPage('report'); document.getElementById('report-date').value='${dateKey}'; renderReport('${dateKey}')">
        <div class="cal-day-num">${d}</div>
        ${holiday ? `<div class="cal-holiday-label" data-tooltip="🎉 ${holiday}">🎉 ${holiday}</div>` : ''}
        ${data ? `<div class="cal-day-total">${formatDurationShort(data.totalMs)}</div>` : ''}
        <div class="cal-day-tasks">${taskPills}</div>
      </div>`;
  }

  html += '</div>';
  html += `
    <div class="cal-legend">
      <span><span class="cal-legend-dot" style="background:#7c6af7"></span> Has work sessions</span>
      <span><span class="cal-legend-dot" style="background:#f59e0b"></span> Public holiday</span>
      <span><span class="cal-legend-dot" style="background:#ffffff30;border:1px solid #7c6af7"></span> Today</span>
      <span style="color:var(--text-secondary);font-size:11px">Click any day to view its report</span>
    </div>`;

  document.getElementById('calendar-container').innerHTML = html;
  // Tooltip logic for holiday labels
  document.querySelectorAll('.cal-holiday-label').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const tip = document.createElement('div');
      tip.id = 'cal-tooltip';
      tip.textContent = el.dataset.tooltip;
      tip.style.cssText = `
      position:fixed; background:#1e1e2e; border:1px solid #f59e0b40;
      color:#f59e0b; font-size:11px; padding:5px 10px; border-radius:6px;
      white-space:nowrap; z-index:9999; box-shadow:0 4px 12px #00000060;
      pointer-events:none; opacity:0;
    `;
      document.body.appendChild(tip);

      const rect = el.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;

      // Position above the label
      let left = rect.left;
      let top = rect.top - tipH - 6;

      // Prevent right overflow
      if (left + tipW > window.innerWidth - 8) {
        left = window.innerWidth - tipW - 8;
      }

      // Prevent top overflow
      if (top < 8) {
        top = rect.bottom + 6;
      }

      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
      tip.style.opacity = '1';
    });
    el.addEventListener('mouseleave', () => {
      document.getElementById('cal-tooltip')?.remove();
    });
  });
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
    btn.addEventListener('click', () => {
      switchPage(btn.dataset.page);
      if (btn.dataset.page === 'planner') renderPlannerProjects();
    });
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

  // Calendar nav
  document.getElementById('cal-prev').addEventListener('click', () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar().catch(console.error);
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar().catch(console.error);
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

  // Init Planner
  initPlanner();
}

document.addEventListener('DOMContentLoaded', init);

// ── Planner ────────────────────────────────────────────────────────────────────

const PLANNER_COLORS = [
  '#7c6af7', '#22d3ee', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#8b5cf6', '#06b6d4', '#14b8a6', '#f97316',
];

let plannerState = {
  projects: [],       // { id, name, desc, color, createdAt }
  versions: [],       // { id, projectId, name, desc, dueDate, pending, createdAt }
  plannerTasks: [],   // { id, versionId, name, notes, priority, createdAt }
  currentProjectId: null,
  editingProjectId: null,
  editingVersionId: null,
  editingPlannerTaskId: null,
  editingVersionTaskTarget: null, // versionId for new task
  selectedColor: PLANNER_COLORS[0],
};

// ── Planner Persistence ───────────────────────────────────────────────────────
async function loadPlannerData() {
  const data = await api.loadData();
  plannerState.projects = data.projects || [];
  plannerState.versions = data.versions || [];
  plannerState.plannerTasks = data.plannerTasks || [];
}

async function savePlannerData() {
  const data = await api.loadData();
  data.projects = plannerState.projects;
  data.versions = plannerState.versions;
  data.plannerTasks = plannerState.plannerTasks;
  await api.saveData(data);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isVersionLocked(version) {
  if (!version.dueDate || version.pending) return false;
  const due = new Date(version.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due <= today;
}

function getDueBadge(version) {
  if (version.pending || !version.dueDate) {
    return `<span class="version-due-badge pending">⏳ Pending</span>`;
  }
  const due = new Date(version.dueDate);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((due - today) / 86400000);
  if (diff < 0) return `<span class="version-due-badge overdue">🔒 Overdue · ${formatShortDate(version.dueDate)}</span>`;
  if (diff === 0) return `<span class="version-due-badge soon">⚠ Due Today</span>`;
  if (diff <= 7) return `<span class="version-due-badge soon">⚠ ${diff}d left · ${formatShortDate(version.dueDate)}</span>`;
  return `<span class="version-due-badge ok">📅 ${formatShortDate(version.dueDate)}</span>`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Render Projects ───────────────────────────────────────────────────────────
function renderPlannerProjects() {
  const grid = document.getElementById('planner-projects-grid');
  grid.innerHTML = '';

  document.getElementById('planner-page-title').textContent = 'Planner';
  document.getElementById('planner-page-subtitle').textContent = 'Manage your projects and versions';
  document.getElementById('btn-planner-new-label').textContent = 'New Project';
  document.getElementById('btn-planner-back').style.display = 'none';
  document.getElementById('planner-projects-view').style.display = '';
  document.getElementById('planner-board-view').style.display = 'none';
  plannerState.currentProjectId = null;

  if (plannerState.projects.length === 0) {
    grid.innerHTML = `
      <div class="planner-empty">
        <div class="planner-empty-icon">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <rect x="4" y="8" width="48" height="40" rx="6" stroke="#ffffff20" stroke-width="2"/>
            <rect x="12" y="16" width="12" height="24" rx="3" stroke="#ffffff15" stroke-width="1.5"/>
            <rect x="28" y="20" width="12" height="20" rx="3" stroke="#ffffff15" stroke-width="1.5"/>
            <rect x="44" y="24" width="6" height="16" rx="2" stroke="#ffffff15" stroke-width="1.5"/>
          </svg>
        </div>
        <h3>No projects yet</h3>
        <p>Create your first project to start planning versions and tasks.</p>
      </div>`;
  } else {
    plannerState.projects.forEach(proj => {
      const versions = plannerState.versions.filter(v => v.projectId === proj.id);
      const taskCount = versions.reduce((acc, v) => acc + plannerState.plannerTasks.filter(t => t.versionId === v.id).length, 0);
      const div = document.createElement('div');
      div.className = 'planner-project-card';
      div.style.setProperty('--proj-color', proj.color || PLANNER_COLORS[0]);
      div.innerHTML = `
        <div class="proj-card-header">
          <div class="proj-card-icon" style="--proj-color:${proj.color}">📋</div>
          <div class="proj-card-actions">
            <button class="proj-action-btn" title="Edit" data-action="edit"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2l2 2-6 6H2V8l6-6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
            <button class="proj-action-btn export" title="Export" data-action="export"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7M3.5 5.5L6 8l2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 9.5v1h8v-1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></button>
            <button class="proj-action-btn danger" title="Delete" data-action="delete"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V2h3v1M4.5 5.5v3.5M7.5 5.5v3.5M3 3l.5 7.5h5L9 3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg></button>
          </div>
        </div>
        <div class="proj-card-name">${proj.name}</div>
        <div class="proj-card-desc">${proj.desc || 'No description'}</div>
        <div class="proj-card-meta">
          <span class="proj-card-meta-item">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 5h10M4 1v2M8 1v2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${versions.length} version${versions.length !== 1 ? 's' : ''}
          </span>
          <span class="proj-card-meta-item">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3.5h8M2 6h6M2 8.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${taskCount} task${taskCount !== 1 ? 's' : ''}
          </span>
        </div>`;
      div.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        openProjectBoard(proj.id);
      });
      div.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectModal(proj.id);
      });
      div.querySelector('[data-action="export"]').addEventListener('click', (e) => {
        e.stopPropagation();
        showProjExportMenu(proj.id, e.currentTarget);
      });
      div.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirm('Delete Project', `Delete "${proj.name}" and all its versions and tasks?`, () => {
          const vids = plannerState.versions.filter(v => v.projectId === proj.id).map(v => v.id);
          plannerState.plannerTasks = plannerState.plannerTasks.filter(t => !vids.includes(t.versionId));
          plannerState.versions = plannerState.versions.filter(v => v.projectId !== proj.id);
          plannerState.projects = plannerState.projects.filter(p => p.id !== proj.id);
          savePlannerData();
          renderPlannerProjects();
          showNotif('Project deleted', 'info');
        });
      });
      grid.appendChild(div);
    });
  }

  // Add card
  const addCard = document.createElement('div');
  addCard.className = 'planner-add-project-card';
  addCard.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M9 2v14M2 9h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> New Project`;
  addCard.addEventListener('click', () => openProjectModal(null));
  grid.appendChild(addCard);
}

// ── Render Board ──────────────────────────────────────────────────────────────
function openProjectBoard(projectId) {
  plannerState.currentProjectId = projectId;
  const proj = plannerState.projects.find(p => p.id === projectId);
  if (!proj) return;

  document.getElementById('planner-page-title').textContent = proj.name;
  document.getElementById('planner-page-subtitle').textContent = proj.desc || 'Project board';
  document.getElementById('btn-planner-new-label').textContent = 'New Version';
  document.getElementById('btn-planner-back').style.display = '';
  document.getElementById('planner-projects-view').style.display = 'none';
  document.getElementById('planner-board-view').style.display = '';

  renderBoard();
}

function renderBoard() {
  const projectId = plannerState.currentProjectId;
  const board = document.getElementById('planner-board');
  board.innerHTML = '';

  const versions = plannerState.versions.filter(v => v.projectId === projectId);

  if (versions.length === 0) {
    board.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:80px 20px;color:var(--text-muted);text-align:center;min-width:100%">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="6" y="8" width="36" height="32" rx="4" stroke="#ffffff20" stroke-width="2"/><rect x="12" y="14" width="10" height="20" rx="2" stroke="#ffffff15" stroke-width="1.5"/><rect x="26" y="18" width="10" height="16" rx="2" stroke="#ffffff15" stroke-width="1.5"/></svg>
      <div style="font-size:14px;font-weight:600;color:var(--text-secondary)">No versions yet</div>
      <div style="font-size:12px">Add a version to start planning tasks.</div>
    </div>`;
  } else {
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id);
      const locked = isVersionLocked(ver);
      const proj = plannerState.projects.find(p => p.id === projectId);
      const verColor = proj?.color || PLANNER_COLORS[0];

      const col = document.createElement('div');
      col.className = `planner-version-col${locked ? ' locked' : ''}`;
      col.style.setProperty('--ver-color', verColor);

      const lockIcon = locked ? `<span class="version-locked-badge">🔒 Locked</span>` : '';

      col.innerHTML = `
        <div class="version-col-header">
          <div class="version-col-actions">
            ${!locked ? `<button class="version-action-btn" title="Edit version" data-action="edit-ver">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M7 2l2 2-5 5H2V7l5-5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
            </button>` : ''}
            <button class="version-action-btn danger" title="Delete version" data-action="delete-ver">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 2.5h8M4 2.5V2h3v.5M4 4.5v4M7 4.5v4M2.5 2.5l.5 7h5l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="version-col-name">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="2" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M1 5h12" stroke="currentColor" stroke-width="1.3"/></svg>
            ${ver.name}
          </div>
          <div class="version-col-meta">
            ${getDueBadge(ver)}
            ${lockIcon}
          </div>
          ${ver.desc ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.4">${ver.desc}</div>` : ''}
        </div>
        <div class="version-tasks-list" id="vtasks-${ver.id}"></div>
        <div class="version-col-footer">
          <button class="btn-add-version-task" data-ver-id="${ver.id}" ${locked ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Add task
          </button>
        </div>`;

      // Render tasks
      const taskList = col.querySelector(`#vtasks-${ver.id}`);
      if (tasks.length === 0) {
        taskList.innerHTML = `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:16px 0">No tasks</div>`;
      } else {
        tasks.forEach(task => {
          const item = document.createElement('div');
          item.className = `planner-task-item${locked ? ' locked' : ''}${task.done ? ' done' : ''}`;
          item.innerHTML = `
          <div class="planner-task-item-actions">
            ${!locked ? `<button class="task-mini-btn" title="Edit" data-action="edit-task" data-task-id="${task.id}">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M6.5 1.5l2 2-5 5H1.5v-2l5-5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
            </button>` : ''}
            <button class="task-mini-btn danger" title="Delete" data-action="delete-task" data-task-id="${task.id}">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2.5h6M3.5 2.5V2h3v.5M3.5 4v3.5M6.5 4v3.5M2.5 2.5l.4 5.5h4.2l.4-5.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="planner-task-name">
            <input type="checkbox" class="task-tick" ${task.done ? 'checked' : ''} ${locked ? 'disabled' : ''} />
            ${task.name}
          </div>
          ${task.notes ? `<div class="planner-task-notes">${task.notes}</div>` : ''}
          <div class="planner-task-footer">
            <span class="priority-badge ${task.priority || 'medium'}">${{ high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low' }[task.priority || 'medium']}</span>
          </div>`;

          const tick = item.querySelector('.task-tick');
          tick?.addEventListener('change', () => {
            task.done = tick.checked;
            savePlannerData();
            item.classList.toggle('done', task.done);
          });
          if (!locked) {
            item.querySelector('[data-action="edit-task"]')?.addEventListener('click', () => openPlannerTaskModal(ver.id, task.id));
          }
          item.querySelector('[data-action="delete-task"]').addEventListener('click', () => {
            if (locked) return;
            showConfirm('Delete Task', `Delete "${task.name}"?`, () => {
              plannerState.plannerTasks = plannerState.plannerTasks.filter(t => t.id !== task.id);
              savePlannerData();
              renderBoard();
              showNotif('Task deleted', 'info');
            });
          });
          taskList.appendChild(item);
        });
      }

      // Version actions
      col.querySelector('[data-action="edit-ver"]')?.addEventListener('click', () => openVersionModal(ver.id));
      col.querySelector('[data-action="delete-ver"]').addEventListener('click', () => {
        showConfirm('Delete Version', `Delete "${ver.name}" and all its tasks?`, () => {
          plannerState.plannerTasks = plannerState.plannerTasks.filter(t => t.versionId !== ver.id);
          plannerState.versions = plannerState.versions.filter(v => v.id !== ver.id);
          savePlannerData();
          renderBoard();
          showNotif('Version deleted', 'info');
        });
      });
      col.querySelector('.btn-add-version-task')?.addEventListener('click', () => openPlannerTaskModal(ver.id, null));

      board.appendChild(col);
    });
  }

  // Add version column
  const addCol = document.createElement('div');
  addCol.className = 'planner-add-version-col';
  addCol.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 3v14M3 10h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>New Version`;
  addCol.addEventListener('click', () => openVersionModal(null));
  board.appendChild(addCol);
}

// ── Project Modal ─────────────────────────────────────────────────────────────
function openProjectModal(projectId) {
  plannerState.editingProjectId = projectId;
  const proj = projectId ? plannerState.projects.find(p => p.id === projectId) : null;

  document.getElementById('planner-project-modal-title').textContent = proj ? 'Edit Project' : 'New Project';
  document.getElementById('planner-project-name').value = proj?.name || '';
  document.getElementById('planner-project-desc').value = proj?.desc || '';
  plannerState.selectedColor = proj?.color || PLANNER_COLORS[0];

  // Render color picker
  const picker = document.getElementById('planner-project-color-picker');
  picker.innerHTML = '';
  PLANNER_COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = `color-swatch${c === plannerState.selectedColor ? ' selected' : ''}`;
    sw.style.background = c;
    sw.addEventListener('click', () => {
      plannerState.selectedColor = c;
      picker.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.style.background === c || s.style.backgroundColor === c));
    });
    picker.appendChild(sw);
  });

  document.getElementById('planner-project-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('planner-project-name').focus(), 50);
}

function closePlannerProjectModal() {
  document.getElementById('planner-project-modal').style.display = 'none';
}

function savePlannerProject() {
  const name = document.getElementById('planner-project-name').value.trim();
  if (!name) { showNotif('Project name required', 'error'); return; }
  const desc = document.getElementById('planner-project-desc').value.trim();
  const color = plannerState.selectedColor;

  if (plannerState.editingProjectId) {
    const proj = plannerState.projects.find(p => p.id === plannerState.editingProjectId);
    if (proj) { proj.name = name; proj.desc = desc; proj.color = color; }
    showNotif('Project updated', 'success');
  } else {
    plannerState.projects.push({ id: genId(), name, desc, color, createdAt: new Date().toISOString() });
    showNotif('Project created', 'success');
  }
  savePlannerData();
  closePlannerProjectModal();
  renderPlannerProjects();
}

// ── Version Modal ─────────────────────────────────────────────────────────────
function openVersionModal(versionId) {
  plannerState.editingVersionId = versionId;
  const ver = versionId ? plannerState.versions.find(v => v.id === versionId) : null;

  document.getElementById('planner-version-modal-title').textContent = ver ? 'Edit Version' : 'New Version';
  document.getElementById('planner-version-name').value = ver?.name || '';
  document.getElementById('planner-version-desc').value = ver?.desc || '';
  document.getElementById('planner-version-duedate').value = ver?.dueDate || '';
  document.getElementById('planner-version-pending').checked = ver ? (ver.pending || !ver.dueDate) : true;

  updateVersionDueDateState();

  document.getElementById('planner-version-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('planner-version-name').focus(), 50);
}

function updateVersionDueDateState() {
  const pending = document.getElementById('planner-version-pending').checked;
  const dateInput = document.getElementById('planner-version-duedate');
  dateInput.disabled = pending;
  dateInput.style.opacity = pending ? '0.4' : '1';
  if (pending) dateInput.value = '';   // ← add this
}

function closePlannerVersionModal() {
  document.getElementById('planner-version-modal').style.display = 'none';
}

function savePlannerVersion() {
  const name = document.getElementById('planner-version-name').value.trim();
  if (!name) { showNotif('Version name required', 'error'); return; }
  const desc = document.getElementById('planner-version-desc').value.trim();
  const pending = document.getElementById('planner-version-pending').checked;
  const dueDate = pending ? null : (document.getElementById('planner-version-duedate').value || null);

  if (plannerState.editingVersionId) {
    const ver = plannerState.versions.find(v => v.id === plannerState.editingVersionId);
    if (ver) { ver.name = name; ver.desc = desc; ver.pending = pending; ver.dueDate = dueDate; }
    showNotif('Version updated', 'success');
  } else {
    plannerState.versions.push({
      id: genId(), projectId: plannerState.currentProjectId,
      name, desc, dueDate, pending,
      createdAt: new Date().toISOString(),
    });
    showNotif('Version created', 'success');
  }
  savePlannerData();
  closePlannerVersionModal();
  renderBoard();
}

// ── Planner Task Modal ────────────────────────────────────────────────────────
function openPlannerTaskModal(versionId, taskId) {
  plannerState.editingVersionTaskTarget = versionId;
  plannerState.editingPlannerTaskId = taskId;
  const task = taskId ? plannerState.plannerTasks.find(t => t.id === taskId) : null;

  document.getElementById('planner-task-modal-title').textContent = task ? 'Edit Task' : 'Add Task';
  document.getElementById('planner-task-name').value = task?.name || '';
  document.getElementById('planner-task-notes').value = task?.notes || '';
  document.getElementById('planner-task-priority').value = task?.priority || 'medium';

  document.getElementById('planner-task-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('planner-task-name').focus(), 50);
}

function closePlannerTaskModal() {
  document.getElementById('planner-task-modal').style.display = 'none';
}

function savePlannerTask() {
  const name = document.getElementById('planner-task-name').value.trim();
  if (!name) { showNotif('Task name required', 'error'); return; }
  const notes = document.getElementById('planner-task-notes').value.trim();
  const priority = document.getElementById('planner-task-priority').value;

  if (plannerState.editingPlannerTaskId) {
    const task = plannerState.plannerTasks.find(t => t.id === plannerState.editingPlannerTaskId);
    if (task) { task.name = name; task.notes = notes; task.priority = priority; }
    showNotif('Task updated', 'success');
  } else {
    plannerState.plannerTasks.push({
      id: genId(),
      versionId: plannerState.editingVersionTaskTarget,
      name, notes, priority,
      done: false,           // ← add this
      createdAt: new Date().toISOString(),
    });
    showNotif('Task added', 'success');
  }
  savePlannerData();
  closePlannerTaskModal();
  renderBoard();
}

// ── Planner Export ────────────────────────────────────────────────────────────
function showProjExportMenu(projId, anchor) {
  document.querySelectorAll('.proj-export-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'proj-export-menu';
  menu.innerHTML = `
    <button data-fmt="txt">📄 Export as TXT</button>
    <button data-fmt="pdf">📕 Export as PDF</button>`;
  const rect = anchor.getBoundingClientRect();
  menu.style.cssText = `position:fixed;top:${rect.bottom + 6}px;left:${rect.left}px;z-index:9999`;
  document.body.appendChild(menu);
  menu.querySelector('[data-fmt="txt"]').addEventListener('click', () => { exportProjectReport(projId, 'txt'); menu.remove(); });
  menu.querySelector('[data-fmt="pdf"]').addEventListener('click', () => { exportProjectReport(projId, 'pdf'); menu.remove(); });
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

async function exportProjectReport(projId, format) {
  const proj = plannerState.projects.find(p => p.id === projId);
  if (!proj) return;
  const versions = plannerState.versions.filter(v => v.projectId === projId);
  const dateStr = todayStr();
  const safeName = proj.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

  if (format === 'txt') {
    let txt = `PROJECT REPORT: ${proj.name}\n`;
    txt += `${'='.repeat(50)}\n`;
    if (proj.desc) txt += `Description: ${proj.desc}\n`;
    txt += `Generated: ${new Date().toLocaleString()}\n`;
    txt += `Versions: ${versions.length}\n\n`;
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id);
      const done = tasks.filter(t => t.done).length;
      txt += `VERSION: ${ver.name}\n${'-'.repeat(40)}\n`;
      if (ver.desc) txt += `  Description: ${ver.desc}\n`;
      txt += `  Due: ${ver.pending ? 'Pending' : (ver.dueDate || 'N/A')}\n`;
      txt += `  Status: ${ver.pending ? 'Pending' : (isVersionLocked(ver) ? 'Locked (Past Due)' : 'Active')}\n`;
      txt += `  Tasks: ${tasks.length} total, ${done} done, ${tasks.length - done} remaining\n\n`;
      tasks.forEach((t, i) => {
        txt += `  ${i + 1}. [${t.done ? 'x' : ' '}] ${t.name}`;
        txt += ` (${t.priority || 'medium'} priority)\n`;
        if (t.notes) txt += `     Notes: ${t.notes}\n`;
      });
      txt += '\n';
    });
    txt += `\nGenerated by WorkTracker`;
    const filepath = await api.exportReport({ content: txt, filename: `${safeName}-${dateStr}.txt`, folder: 'ProjectPlans' });
    showNotif(`Saved: ${filepath}`, 'success');

  } else if (format === 'pdf') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 20;
    let y = margin;
    const checkPage = (needed = 10) => { if (y + needed > pageH - margin) { doc.addPage(); y = margin; } };
    const projColor = proj.color || '#7c6af7';
    const rgb = hexToRgb(projColor);

    // Header bar
    doc.setFillColor(rgb.r, rgb.g, rgb.b);
    doc.rect(0, 0, pageW, 30, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(18); doc.setFont('helvetica', 'bold');
    doc.text(proj.name, margin, 16);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text('Project Report', margin, 24);
    doc.text(new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }), pageW - margin, 24, { align: 'right' });
    y = 40;

    // Description
    if (proj.desc) {
      doc.setTextColor(80, 80, 80); doc.setFontSize(10); doc.setFont('helvetica', 'italic');
      doc.text(proj.desc, margin, y); y += 10;
    }

    // Summary box
    const totalTasks = plannerState.plannerTasks.filter(t => versions.some(v => v.id === t.versionId)).length;
    const doneTasks = plannerState.plannerTasks.filter(t => versions.some(v => v.id === t.versionId) && t.done).length;
    doc.setFillColor(245, 245, 255);
    doc.roundedRect(margin, y, pageW - margin * 2, 14, 3, 3, 'F');
    doc.setTextColor(60, 60, 60); doc.setFontSize(9); doc.setFont('helvetica', 'bold');
    doc.text(`Versions: ${versions.length}`, margin + 6, y + 9);
    doc.text(`Total Tasks: ${totalTasks}`, pageW / 2 - 20, y + 9);
    doc.text(`Completed: ${doneTasks} / ${totalTasks}`, pageW - margin - 6, y + 9, { align: 'right' });
    y += 22;

    // Versions
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id);
      const done = tasks.filter(t => t.done).length;
      checkPage(20);

      // Version header
      doc.setFillColor(rgb.r, rgb.g, rgb.b);
      doc.roundedRect(margin, y, pageW - margin * 2, 10, 2, 2, 'F');
      doc.setTextColor(255, 255, 255); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(ver.name, margin + 4, y + 7);
      const dueTxt = ver.pending ? 'Pending' : (ver.dueDate || 'N/A');
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      doc.text(`Due: ${dueTxt}   Tasks: ${done}/${tasks.length} done`, pageW - margin - 4, y + 7, { align: 'right' });
      y += 13;

      if (ver.desc) {
        doc.setTextColor(100, 100, 100); doc.setFontSize(8); doc.setFont('helvetica', 'italic');
        doc.text(ver.desc, margin + 2, y); y += 7;
      }

      // Tasks
      if (tasks.length === 0) {
        doc.setTextColor(160, 160, 160); doc.setFontSize(8); doc.setFont('helvetica', 'normal');
        doc.text('No tasks', margin + 4, y); y += 8;
      } else {
        tasks.forEach((task, i) => {
          checkPage(10);
          if (i % 2 === 0) { doc.setFillColor(250, 250, 255); doc.rect(margin, y, pageW - margin * 2, 9, 'F'); }
          // Checkbox
          doc.setDrawColor(180, 180, 180);
          doc.roundedRect(margin + 3, y + 2, 5, 5, 1, 1, 'S');
          if (task.done) {
            doc.setDrawColor(rgb.r, rgb.g, rgb.b);
            doc.setFillColor(rgb.r, rgb.g, rgb.b);
            doc.roundedRect(margin + 3, y + 2, 5, 5, 1, 1, 'FD');
            doc.setTextColor(255, 255, 255); doc.setFontSize(6);
            doc.text('✓', margin + 4.5, y + 6);
          }
          // Task name
          const nameColor = task.done ? [160, 160, 160] : [30, 30, 30];
          doc.setTextColor(...nameColor); doc.setFontSize(9);
          doc.setFont('helvetica', task.done ? 'normal' : 'bold');
          doc.text(task.name, margin + 11, y + 6.5);
          // Priority badge
          const pColors = { high: [239, 68, 68], medium: [234, 179, 8], low: [34, 197, 94] };
          const pc = pColors[task.priority || 'medium'];
          doc.setTextColor(...pc); doc.setFontSize(7); doc.setFont('helvetica', 'normal');
          doc.text((task.priority || 'medium').toUpperCase(), pageW - margin - 4, y + 6.5, { align: 'right' });
          y += 9;
          if (task.notes) {
            checkPage(7);
            doc.setTextColor(120, 120, 120); doc.setFontSize(7.5); doc.setFont('helvetica', 'italic');
            doc.text(`   ${task.notes}`, margin + 11, y); y += 7;
          }
        });
      }
      y += 6;
    });

    // Footer
    checkPage(12);
    doc.setDrawColor(200, 200, 200); doc.line(margin, y, pageW - margin, y); y += 7;
    doc.setFontSize(8); doc.setTextColor(150, 150, 150); doc.setFont('helvetica', 'normal');
    doc.text('Generated by WorkTracker', margin, y);
    doc.text(`${new Date().toLocaleString()}`, pageW - margin, y, { align: 'right' });

    const base64 = btoa(String.fromCharCode(...new Uint8Array(doc.output('arraybuffer'))));
    const filepath = await api.exportReport({ content: base64, filename: `${safeName}-${dateStr}.pdf`, isPdf: true, folder: 'ProjectPlans' });
    showNotif(`PDF saved: ${filepath}`, 'success');
  }
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

// ── Planner Init ──────────────────────────────────────────────────────────────
function initPlanner() {
  // New project/version button
  document.getElementById('btn-planner-new').addEventListener('click', () => {
    if (plannerState.currentProjectId) openVersionModal(null);
    else openProjectModal(null);
  });

  // Back button
  document.getElementById('btn-planner-back').addEventListener('click', renderPlannerProjects);

  // Project modal
  document.getElementById('planner-project-modal-close').addEventListener('click', closePlannerProjectModal);
  document.getElementById('planner-project-modal-cancel').addEventListener('click', closePlannerProjectModal);
  document.getElementById('planner-project-modal-save').addEventListener('click', savePlannerProject);
  document.getElementById('planner-project-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlannerProjectModal();
  });
  document.getElementById('planner-project-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePlannerProject();
    if (e.key === 'Escape') closePlannerProjectModal();
  });

  // Version modal
  document.getElementById('planner-version-modal-close').addEventListener('click', closePlannerVersionModal);
  document.getElementById('planner-version-modal-cancel').addEventListener('click', closePlannerVersionModal);
  document.getElementById('planner-version-modal-save').addEventListener('click', savePlannerVersion);
  document.getElementById('planner-version-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlannerVersionModal();
  });
  document.getElementById('planner-version-pending').addEventListener('change', updateVersionDueDateState);
  document.getElementById('planner-version-name').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePlannerVersionModal();
  });
  document.getElementById('planner-version-duedate').addEventListener('change', () => {
    if (document.getElementById('planner-version-duedate').value) {
      document.getElementById('planner-version-pending').checked = false;
      updateVersionDueDateState();
    }
  });

  // Task modal
  document.getElementById('planner-task-modal-close').addEventListener('click', closePlannerTaskModal);
  document.getElementById('planner-task-modal-cancel').addEventListener('click', closePlannerTaskModal);
  document.getElementById('planner-task-modal-save').addEventListener('click', savePlannerTask);
  document.getElementById('planner-task-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlannerTaskModal();
  });
  document.getElementById('planner-task-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePlannerTask();
    if (e.key === 'Escape') closePlannerTaskModal();
  });
}