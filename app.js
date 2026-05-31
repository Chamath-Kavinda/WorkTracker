// ── WorkTracker App ──────────────────────────────────────────────────────────
const api = window.electronAPI;

// ── Firebase Auth ─────────────────────────────────────────────────────────────
let fbAuth = null;
let fbDb = null;
let currentUser = null;
let _firestoreUnsubscribe = null; // real-time listener handle

// Hardcoded Firebase config (no settings UI needed)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBbH6td0Q4eTa4JXLDhoMk8gfNpS1m5INQ",
  authDomain: "worktracker-29228.firebaseapp.com",
  projectId: "worktracker-29228",
  storageBucket: "worktracker-29228.firebasestorage.app",
  messagingSenderId: "482821840009",
  appId: "1:482821840009:web:9ce9490b49639367713a58",
};

// ── Sync helpers ──────────────────────────────────────────────────────────────

// Returns true if the data payload has any meaningful content
function _hasData(data) {
  return !!(data.tasks?.length || data.sessions?.length ||
    data.projects?.length || data.versions?.length ||
    data.plannerTasks?.length);
}

// Wipe the local electron store
async function _clearLocalData() {
  try {
    await api.saveData({ tasks: [], sessions: [], projects: [], versions: [], plannerTasks: [] });
  } catch (e) { console.warn('Could not clear local data:', e); }
}

// Apply a data payload to in-memory state
function _applyState(data) {
  state.tasks = data.tasks || [];
  state.sessions = data.sessions || [];
  plannerState.projects = data.projects || [];
  plannerState.versions = data.versions || [];
  plannerState.plannerTasks = data.plannerTasks || [];
}

// Merge local + cloud by id union — no duplicates, nothing lost
function _mergeData(local, cloud) {
  const mergeArr = (a, b) => {
    const map = {};
    [...(a || []), ...(b || [])].forEach(item => { if (item?.id) map[item.id] = item; });
    return Object.values(map);
  };
  return {
    tasks: mergeArr(local.tasks, cloud.tasks),
    sessions: mergeArr(local.sessions, cloud.sessions),
    projects: mergeArr(local.projects, cloud.projects),
    versions: mergeArr(local.versions, cloud.versions),
    plannerTasks: mergeArr(local.plannerTasks, cloud.plannerTasks),
  };
}

// ── Firebase init ─────────────────────────────────────────────────────────────
async function initFirebase() {
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDb = firebase.firestore();

    fbAuth.onAuthStateChanged(async user => {
      currentUser = user;
      updateAuthUI(user);

      // Tear down any previous real-time listener
      if (_firestoreUnsubscribe) { _firestoreUnsubscribe(); _firestoreUnsubscribe = null; }

      if (user && fbDb) {
        // ── SIGNED IN ──────────────────────────────────────────────────────────
        // 1. Read whatever is in local store (saved while logged out)
        const localData = await api.loadData();
        const hasLocal = _hasData(localData);

        // 2. Read this account's cloud data
        let cloudData = null;
        try {
          const doc = await fbDb.collection('users').doc(user.uid).get();
          if (doc.exists) cloudData = doc.data();
        } catch (e) { console.warn('Could not read cloud data:', e); }

        let finalData;
        if (hasLocal && cloudData) {
          // Both exist → merge (keeps everything from both, no data lost)
          finalData = _mergeData(localData, cloudData);
          showNotif('Local data merged with your account ☁️', 'success');
        } else if (hasLocal) {
          // Only local → upload to cloud (first login on this device)
          finalData = localData;
          showNotif('Local data saved to your account ☁️', 'success');
        } else if (cloudData) {
          // Only cloud → load it (returning user on clean device)
          finalData = cloudData;
        } else {
          // Nothing anywhere → fresh start
          finalData = { tasks: [], sessions: [], projects: [], versions: [], plannerTasks: [] };
        }

        // 3. Push merged/final data to cloud
        try {
          await fbDb.collection('users').doc(user.uid).set(finalData);
        } catch (e) { console.warn('Could not push data to cloud:', e); }

        // 4. Wipe local store — cloud is now the single source of truth
        await _clearLocalData();

        // 5. Apply to in-memory state and render
        _applyState(finalData);
        renderAll();

        // 6. Start real-time listener for live cross-device sync
        _firestoreUnsubscribe = fbDb.collection('users').doc(user.uid)
          .onSnapshot(snapshot => {
            if (!snapshot.exists) return;
            const data = snapshot.data();
            const incoming = JSON.stringify({
              t: data.tasks, s: data.sessions,
              p: data.projects, v: data.versions, pt: data.plannerTasks
            });
            const current = JSON.stringify({
              t: state.tasks, s: state.sessions,
              p: plannerState.projects, v: plannerState.versions, pt: plannerState.plannerTasks
            });
            if (incoming !== current) {
              _applyState(data);
              renderAll();
              showNotif('Synced from another device 🔄', 'info');
            }
          }, err => {
            console.warn('Firestore real-time sync error:', err);
          });

      } else {
        // ── SIGNED OUT ─────────────────────────────────────────────────────────
        // Clear in-memory state — user must log in to see their data
        _applyState({ tasks: [], sessions: [], projects: [], versions: [], plannerTasks: [] });
        // Also wipe local store so no residual data sits on disk
        await _clearLocalData();
        renderAll();
      }
    });
  } catch (e) {
    console.warn('Firebase init failed:', e);
    // Last-resort fallback: load from local if Firebase is completely unreachable
    await loadData();
    renderAll();
  }
}

// ── Auth actions ──────────────────────────────────────────────────────────────
async function signInWithGoogle() {
  if (!fbAuth) return;
  clearAuthError();

  // Show a loading state on the Google button
  const googleBtn = document.getElementById('btn-google-signin');
  const originalHTML = googleBtn.innerHTML;
  googleBtn.disabled = true;
  googleBtn.innerHTML = `<span style="display:flex;align-items:center;gap:10px;justify-content:center">
    <span style="width:16px;height:16px;border:2px solid #33333350;border-top-color:#333;border-radius:50%;animation:spin .7s linear infinite;display:inline-block"></span>
    Connecting to Google...
  </span>`;

  try {
    // Use Electron's main-process window to handle Google OAuth
    // This avoids the popup-blocked issue in Electron's renderer
    const result = await api.googleSignIn();

    if (result && (result.accessToken || result.idToken)) {
      const credential = firebase.auth.GoogleAuthProvider.credential(
        result.idToken || null,
        result.accessToken || null
      );
      await fbAuth.signInWithCredential(credential);
      hideAuthModal();
      showNotif('Signed in with Google!', 'success');
      return;
    }

    showAuthError('Google sign-in did not complete. Please try again.');
  } catch (e) {
    if (e.message === 'auth-port-busy') {
      showAuthError('Sign-in port is busy. Please wait a moment and try again.');
    } else if (e.message === 'auth/popup-closed-by-user') {
      // User just closed the window — no error needed
    } else {
      showAuthError(friendlyAuthError(e.code) || e.message);
    }
  } finally {
    googleBtn.disabled = false;
    googleBtn.innerHTML = originalHTML;
  }
}

async function signInWithEmail(email, password) {
  if (!fbAuth) return;
  setAuthLoading(true);
  try {
    await fbAuth.signInWithEmailAndPassword(email, password);
    hideAuthModal();
    showNotif('Signed in!', 'success');
  } catch (e) {
    showAuthError(friendlyAuthError(e.code));
  } finally { setAuthLoading(false); }
}

async function registerWithEmail(email, password, displayName) {
  if (!fbAuth) return;
  setAuthLoading(true);
  try {
    const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
    if (displayName) await cred.user.updateProfile({ displayName });
    hideAuthModal();
    showNotif('Account created! Welcome 🎉', 'success');
  } catch (e) {
    showAuthError(friendlyAuthError(e.code));
  } finally { setAuthLoading(false); }
}

async function doSignOut() {
  if (!fbAuth) return;
  showSignOutConfirm();
}

function showSignOutConfirm() {
  // Remove any existing confirm dialog
  document.getElementById('signout-confirm-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'signout-confirm-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;
    display:flex;align-items:center;justify-content:center;
    animation:fadeIn .15s ease;
  `;
  overlay.innerHTML = `
    <div style="background:#1a1a24;border:1px solid #ffffff14;border-radius:14px;
                padding:28px 32px;width:340px;text-align:center;
                animation:slideUp .2s ease;">
      <div style="width:48px;height:48px;border-radius:50%;background:#ef444415;
                  display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:22px;">
        🔓
      </div>
      <h3 style="margin:0 0 8px;font-size:17px;font-weight:700;color:#fff;">Sign out?</h3>
      <p style="margin:0 0 24px;font-size:13px;color:#888;line-height:1.5;">
        Your data stays in the cloud.<br>Local data will be cleared for security.<br>Sign back in anytime to access it.
      </p>
      <div style="display:flex;gap:10px;">
        <button id="signout-cancel-btn" style="flex:1;padding:10px;border-radius:8px;border:1px solid #ffffff18;
                background:none;color:#ccc;cursor:pointer;font-size:14px;font-weight:500;
                transition:background .15s;">
          Cancel
        </button>
        <button id="signout-confirm-btn" style="flex:1;padding:10px;border-radius:8px;border:none;
                background:#ef4444;color:#fff;cursor:pointer;font-size:14px;font-weight:600;
                transition:opacity .15s;">
          Sign Out
        </button>
      </div>
    </div>
  `;

  // Add keyframe animations
  if (!document.getElementById('signout-confirm-styles')) {
    const style = document.createElement('style');
    style.id = 'signout-confirm-styles';
    style.textContent = `
      @keyframes fadeIn  { from { opacity:0 } to { opacity:1 } }
      @keyframes slideUp { from { transform:translateY(16px);opacity:0 } to { transform:translateY(0);opacity:1 } }
      #signout-cancel-btn:hover  { background:#ffffff10 !important; }
      #signout-confirm-btn:hover { opacity:.85 !important; }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(overlay);

  overlay.querySelector('#signout-cancel-btn').onclick = () => overlay.remove();
  overlay.querySelector('#signout-confirm-btn').onclick = async () => {
    overlay.remove();
    // onAuthStateChanged handles clearing state + local store automatically
    await fbAuth.signOut();
    showNotif('Signed out — data cleared locally', 'info');
  };
  // Close on backdrop click
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-email': 'Invalid email address.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/email-already-in-use': 'This email is already registered.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user': 'Sign-in popup was closed.',
    'auth/network-request-failed': 'Network error. Check your connection.',
  };
  return map[code] || 'Sign-in failed. Please try again.';
}

// ── Auth UI ───────────────────────────────────────────────────────────────────
let authMode = 'signin';

function showAuthModal() {
  document.getElementById('auth-modal-overlay').style.display = 'flex';
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-displayname').value = '';
  clearAuthError();
  setAuthModeUI('signin');
  setTimeout(() => document.getElementById('auth-email').focus(), 60);
}

function hideAuthModal() {
  document.getElementById('auth-modal-overlay').style.display = 'none';
}

function setAuthModeUI(mode) {
  authMode = mode;
  const reg = mode === 'register';
  document.getElementById('auth-modal-title').textContent = reg ? 'Create account' : 'Welcome back';
  document.getElementById('auth-modal-subtitle').textContent = reg ? 'Join WorkTracker today' : 'Sign in to sync your data';
  document.getElementById('auth-submit-label').textContent = reg ? 'Create Account' : 'Sign In';
  document.getElementById('auth-toggle-text').textContent = reg ? 'Already have an account?' : "Don't have an account?";
  document.getElementById('btn-auth-toggle').textContent = reg ? 'Sign In' : 'Register';
  document.getElementById('auth-name-field').style.display = reg ? '' : 'none';
  clearAuthError();
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error-box');
  el.textContent = msg;
  el.style.display = 'block';
  document.getElementById('auth-email').classList.add('error');
  document.getElementById('auth-password').classList.add('error');
}

function clearAuthError() {
  document.getElementById('auth-error-box').style.display = 'none';
  document.getElementById('auth-email').classList.remove('error');
  document.getElementById('auth-password').classList.remove('error');
}

function setAuthLoading(on) {
  const btn = document.getElementById('btn-auth-submit');
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

function updateAuthUI(user) {
  const profile = document.getElementById('auth-profile');
  const signInBtn = document.getElementById('btn-signin-titlebar');
  // Settings page panels
  const settingsOut = document.getElementById('settings-account-signed-out');
  const settingsIn = document.getElementById('settings-account-signed-in');

  const bellBtn = document.getElementById('notif-bell-btn');
  if (user) {
    profile.style.display = 'flex';
    signInBtn.style.display = 'none';
    if (bellBtn) bellBtn.style.display = 'flex';
    const avatar = document.getElementById('auth-avatar');
    avatar.src = user.photoURL || '';
    avatar.style.display = user.photoURL ? '' : 'none';
    document.getElementById('auth-username').textContent = user.displayName || user.email;
    if (settingsIn) {
      settingsIn.style.display = '';
      settingsOut.style.display = 'none';
      document.getElementById('settings-user-email').textContent = user.email;
    }
  } else {
    profile.style.display = 'none';
    signInBtn.style.display = '';
    if (bellBtn) { bellBtn.style.display = 'none'; document.getElementById('notif-dropdown').style.display = 'none'; }
    if (settingsOut) {
      settingsOut.style.display = '';
      settingsIn.style.display = 'none';
    }
  }
}

function initAuthUI() {
  // Titlebar
  document.getElementById('btn-signin-titlebar').addEventListener('click', showAuthModal);

  // Settings page
  document.getElementById('btn-settings-signin')?.addEventListener('click', showAuthModal);
  document.getElementById('btn-settings-signout')?.addEventListener('click', doSignOut);

  // Modal close
  document.getElementById('auth-modal-close').addEventListener('click', hideAuthModal);
  document.getElementById('btn-auth-skip').addEventListener('click', hideAuthModal);
  document.getElementById('auth-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'auth-modal-overlay') hideAuthModal();
  });

  // Google
  document.getElementById('btn-google-signin').addEventListener('click', signInWithGoogle);

  // Toggle mode
  document.getElementById('btn-auth-toggle').addEventListener('click', () => {
    setAuthModeUI(authMode === 'signin' ? 'register' : 'signin');
  });

  // Submit
  document.getElementById('btn-auth-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-displayname').value.trim();
    clearAuthError();
    if (!email) { showAuthError('Please enter your email.'); return; }
    if (!password) { showAuthError('Please enter your password.'); return; }
    if (authMode === 'register') await registerWithEmail(email, password, name);
    else await signInWithEmail(email, password);
  });

  // Enter key
  ['auth-email', 'auth-password', 'auth-displayname'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-auth-submit').click();
    });
  });

  // Eye toggle
  document.getElementById('auth-eye-toggle').addEventListener('click', () => {
    const input = document.getElementById('auth-password');
    const isPass = input.type === 'password';
    input.type = isPass ? 'text' : 'password';
    document.getElementById('eye-icon-show').style.display = isPass ? 'none' : '';
    document.getElementById('eye-icon-hide').style.display = isPass ? '' : 'none';
  });
}

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  tasks: [],
  sessions: [],
  activeTaskId: null,
  activeSessionStart: null,
  currentFilter: 'all',
  currentCategoryFilter: 'all',
  currentPage: 'dashboard',
  timerInterval: null,
};
let selectedCountry = 'LK';

// IANA timezone for each country in the settings dropdown
const COUNTRY_TIMEZONE = {
  LK: 'Asia/Colombo',
  US: 'America/New_York',
  GB: 'Europe/London',
  IN: 'Asia/Kolkata',
  AU: 'Australia/Sydney',
  SG: 'Asia/Singapore',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  JP: 'Asia/Tokyo',
  CA: 'America/Toronto',
};

// Returns the IANA timezone string for the currently selected country
function getUserTimezone() {
  return COUNTRY_TIMEZONE[selectedCountry] || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Returns a YYYY-MM-DD string in the user's local timezone
function localDateStr(date) {
  const d = date || new Date();
  const tz = getUserTimezone();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

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
  // Uses the user's selected country timezone — no hardcoding
  return localDateStr(new Date());
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
  let data = null;
  if (currentUser && fbDb) {
    try {
      const doc = await fbDb.collection('users').doc(currentUser.uid).get();
      if (doc.exists) data = doc.data();
    } catch (e) { console.warn('Firestore load failed, using local:', e); }
  }
  if (!data) data = await api.loadData();

  state.tasks = data.tasks || [];
  state.sessions = data.sessions || [];
  plannerState.projects = data.projects || [];
  plannerState.versions = data.versions || [];
  plannerState.plannerTasks = data.plannerTasks || [];
}

async function saveData() {
  const payload = {
    tasks: state.tasks,
    sessions: state.sessions,
    projects: plannerState.projects,
    versions: plannerState.versions,
    plannerTasks: plannerState.plannerTasks,
  };
  if (currentUser && fbDb) {
    // Logged in — save to cloud only (local store stays empty for security)
    try { await fbDb.collection('users').doc(currentUser.uid).set(payload); }
    catch (e) {
      console.warn('Firestore save failed, buffering locally:', e);
      await api.saveData(payload); // offline buffer — will merge on next sign-in
    }
  } else {
    // Not logged in — save locally
    await api.saveData(payload);
  }
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

  const task = state.tasks.find(t => t.id === taskId);
  const existingMs = getTaskTotalMs(taskId) - (Date.now() - state.activeSessionStart);
  if (api.setActiveTimer) api.setActiveTimer({
    taskName: task?.name,
    startedAt: state.activeSessionStart - existingMs  // offset back by prior sessions
  });

  // Update task status
  if (task) task.status = 'running';

  saveData();
  startTimerInterval();
  renderAll();
  showNotif(`Started: ${task?.name}`, 'info');
}

function pauseTask(taskId) {
  if (state.activeTaskId !== taskId) return;
  stopCurrentSession(false); // this already calls setActiveTimer null
  renderAll();
  const task = state.tasks.find(t => t.id === taskId);
  showNotif(`Paused: ${task?.name}`, 'info');
}

function stopTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  showConfirm('Stop Task', `Mark "${task?.name || 'this task'}" as complete?`, () => {
    if (state.activeTaskId === taskId) {
      stopCurrentSession(true);
    } else {
      if (task) task.status = 'completed';
      saveData();
    }
    renderAll();
    showNotif(`Stopped: ${task?.name}`, 'success');
  });
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

  // In stopCurrentSession(), after state.activeTaskId = null:
  if (api.setActiveTimer) api.setActiveTimer({ taskName: null, startedAt: null });

  clearInterval(state.timerInterval);
  state.timerInterval = null;

  saveData();
}

function startTimerInterval() {
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    updateLiveTimer();
    checkMidnightAutoComplete();
  }, 1000);
}

// ── Midnight auto-complete ────────────────────────────────────────────────────
// If a task was left running and the date has rolled past midnight,
// split the session at midnight, mark task completed, and save.
function checkMidnightAutoComplete() {
  if (!state.activeTaskId || !state.activeSessionStart) return;

  const startDate = localDateStr(new Date(state.activeSessionStart)); // user-timezone date
  const today = todayStr();

  if (startDate === today) return; // same day, nothing to do

  const task = state.tasks.find(t => t.id === state.activeTaskId);

  // Midnight boundary = start of today in the user's timezone (approximated as local midnight)
  const midnightToday = new Date(today + 'T00:00:00').getTime();

  // Duration = from session start → midnight of start day
  const durationUntilMidnight = midnightToday - state.activeSessionStart;

  // Save the session on the OLD date (the day it started)
  state.sessions.push({
    id: genId(),
    taskId: state.activeTaskId,
    taskName: task?.name || 'Unknown',
    date: startDate,
    startTime: new Date(state.activeSessionStart).toISOString(),
    endTime: new Date(midnightToday - 1).toISOString(), // 23:59:59.999 of that day
    duration: Math.max(0, durationUntilMidnight),
    autoCompleted: true,
  });

  // Mark task completed
  if (task) task.status = 'completed';

  // Clear active timer state
  state.activeTaskId = null;
  state.activeSessionStart = null;
  clearInterval(state.timerInterval);
  state.timerInterval = null;

  saveData();
  renderAll();
  showNotif(`"${task?.name}" auto-completed at midnight ✅`, 'success');
}

// Run once on startup to catch any task that was running when the app was closed across midnight
function autoCompleteOnStartup() {
  if (!state.activeTaskId || !state.activeSessionStart) return;
  checkMidnightAutoComplete();
}

function updateLiveTimer() {
  if (!state.activeTaskId || !state.activeSessionStart) return;
  const elapsed = Date.now() - state.activeSessionStart;
  const totalMs = getTaskTotalMs(state.activeTaskId);

  // Update active timer display
  const display = document.getElementById('active-timer-display');
  if (display) display.textContent = formatDuration(totalMs);

  // Update task card time inline if visible (both dashboard and tasks page)
  document.querySelectorAll(`[data-task-id="${state.activeTaskId}"] .task-card-time`).forEach(card => {
    card.textContent = formatDuration(totalMs);
  });

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
  renderNotifBell();
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

function createTaskCard(task, options = {}) {
  const status = getTaskStatus(task);
  const totalMs = getTaskTotalMs(task.id);
  const isRunning = status === 'running';

  // A task is "locked" if it belongs to a past date (cannot be started/paused/stopped)
  const taskDate = task.date || task.createdAt?.slice(0, 10) || todayStr();
  const isPastDay = taskDate < todayStr() && !isRunning;

  const div = document.createElement('div');
  div.className = `task-card${isRunning ? ' active-tracking' : ''}${isPastDay ? ' locked-day' : ''}`;
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
        ${isPastDay ? `<span class="task-locked-badge" title="Past day — locked">🔒 Locked</span>` : ''}
      </div>
    </div>
    <div class="task-card-time ${isRunning ? 'running' : ''}">${formatDuration(totalMs)}</div>
    <div class="task-card-actions">
      ${!isPastDay && !isRunning && status !== 'completed'
      ? `<button class="task-btn start" title="Start" data-action="start">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg>
           </button>`
      : ''}
      ${isRunning
      ? `<button class="task-btn pause-btn" title="Pause" data-action="pause">
            <svg width="12" height="14" viewBox="0 0 12 14"><rect width="4" height="14" rx="2" fill="currentColor"/><rect x="8" width="4" height="14" rx="2" fill="currentColor"/></svg>
           </button>`
      : ''}
      ${(isRunning || (!isPastDay && status === 'paused'))
      ? `<button class="task-btn stop-btn" title="Stop / Mark Complete" data-action="stop">
            <svg width="13" height="13" viewBox="0 0 13 13"><rect width="13" height="13" rx="2.5" fill="currentColor"/></svg>
           </button>`
      : ''}
      ${options.showDelete && taskDate >= todayStr()
      ? `<button class="task-btn edit" title="Edit task" data-action="edit">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 11l2.5-.5L11 4a1.4 1.4 0 00-2-2L2.5 8.5 2 11z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
           </button>
           <button class="task-btn delete" title="Delete task" data-action="delete">
            <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 3h9M5 3V2h3v1M5 6v4M8 6v4M3 3l.7 8h5.6L10 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>
           </button>`
      : ''}
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
      else if (action === 'edit') editTask(task.id);
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

  todayTasks.forEach(task => list.appendChild(createTaskCard(task, { showDelete: false })));

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

  // ── Render category filter chips ──────────────────────────────────────────
  const CATEGORIES = ['all', 'work', 'meeting', 'design', 'development', 'research', 'admin', 'other'];
  const CAT_LABELS = {
    all: 'All Categories', work: '💼 Work', meeting: '🗣️ Meeting', design: '🎨 Design',
    development: '💻 Development', research: '🔍 Research', admin: '📋 Admin', other: '📌 Other'
  };

  const catBar = document.getElementById('tasks-category-bar');
  if (catBar) {
    catBar.innerHTML = CATEGORIES.map(c => `
      <button class="cat-filter-btn${state.currentCategoryFilter === c ? ' active' : ''}" data-cat="${c}">
        ${CAT_LABELS[c]}
      </button>`).join('');
    catBar.querySelectorAll('.cat-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.currentCategoryFilter = btn.dataset.cat;
        renderTasksPage();
      });
    });
  }

  // ── Apply status filter ───────────────────────────────────────────────────
  let tasks = [...state.tasks];
  if (state.currentFilter !== 'all') {
    tasks = tasks.filter(t => {
      const status = getTaskStatus(t);
      if (state.currentFilter === 'active') return status === 'running';
      if (state.currentFilter === 'paused') return status === 'paused';
      if (state.currentFilter === 'completed') return status === 'completed';
      return true;
    });
  }

  // ── Apply category filter ─────────────────────────────────────────────────
  if (state.currentCategoryFilter !== 'all') {
    tasks = tasks.filter(t => (t.category || 'other') === state.currentCategoryFilter);
  }

  if (tasks.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="#ffffff15" stroke-width="2"/><path d="M16 24h16M16 17h16M16 31h10" stroke="#ffffff20" stroke-width="2" stroke-linecap="round"/></svg>
      <p>No tasks found.</p>
    </div>`;
    return;
  }

  // ── Group by date (newest first) ──────────────────────────────────────────
  const today = todayStr();
  const yesterday = localDateStr(new Date(Date.now() - 864e5));

  const groups = {};
  tasks.forEach(task => {
    const key = task.date || task.createdAt?.slice(0, 10) || today;
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  sortedDates.forEach(date => {
    // Date header
    let label;
    if (date === today) label = `Today <span class="date-group-sub">${formatDateFull(date)}</span>`;
    else if (date === yesterday) label = `Yesterday <span class="date-group-sub">${formatDateFull(date)}</span>`;
    else label = formatDateFull(date);

    const header = document.createElement('div');
    header.className = 'date-group-header';
    header.innerHTML = `<span class="date-group-label">${label}</span>
      <span class="date-group-count">${groups[date].length} task${groups[date].length !== 1 ? 's' : ''}</span>`;
    list.appendChild(header);

    groups[date].forEach(task => list.appendChild(createTaskCard(task, { showDelete: true })));
  });
}

function formatDateFull(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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

  // Day streak — count consecutive calendar days (including today) that have sessions
  const sumStreak = document.getElementById('sum-streak');
  if (sumStreak) sumStreak.textContent = calcDayStreak();
}

function calcDayStreak() {
  const datesWithWork = new Set(state.sessions.map(s => s.date));
  let streak = 0;
  let ts = Date.now();
  let checkingToday = true;
  while (true) {
    const dateKey = localDateStr(new Date(ts));

    if (datesWithWork.has(dateKey)) {
      streak++;
      checkingToday = false;
    } else {
      if (checkingToday) {
        checkingToday = false;
        ts -= 864e5;
        continue;
      }
      break;
    }

    ts -= 864e5;
    if (streak > 3650) break;
  }
  return streak;
}

// ── Planner Version Notifications ─────────────────────────────────────────────
// readNotifIds: set of version IDs the user has manually marked as read.
// Persisted to settings.json so the bell doesn't re-shake after a restart.
const _readNotifIds = new Set();

async function _saveReadNotifIds() {
  try {
    const settings = await api.loadSettings();
    const validVersionIds = new Set(plannerState.versions.map(v => v.id));
    settings.readNotifIds = [..._readNotifIds].filter(id => validVersionIds.has(id));
    await api.saveSettings(settings);
  } catch (e) { console.warn('Could not persist read-notif state:', e); }
}

function getVersionNotifications() {
  const notifications = [];
  const today = todayStr();

  plannerState.versions.forEach(ver => {
    if (!ver.dueDate || ver.pending) return;
    const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id);
    if (tasks.length === 0) return;
    const allDone = tasks.every(t => t.done);
    if (allDone) return;

    const project = plannerState.projects.find(p => p.id === ver.projectId);
    const projectName = project?.name || 'Unknown Project';
    const dueDate = new Date(ver.dueDate + 'T00:00:00');
    const todayDate = new Date(today + 'T00:00:00');
    const daysLeft = Math.round((dueDate - todayDate) / (1000 * 60 * 60 * 24));
    const doneCnt = tasks.filter(t => t.done).length;
    const totalCnt = tasks.length;
    const remaining = totalCnt - doneCnt;

    let urgency, icon, message;

    if (daysLeft <= 0) {
      urgency = 'urgent'; icon = '🚨';
      message = daysLeft === 0
        ? `Release day! ${remaining} task${remaining !== 1 ? 's' : ''} still pending`
        : `Overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''} — ${remaining} unfinished`;
    } else if (daysLeft === 1) {
      urgency = 'urgent'; icon = '⚡';
      message = `Due tomorrow! ${remaining} task${remaining !== 1 ? 's' : ''} not done`;
    } else if (daysLeft === 2) {
      urgency = 'warning'; icon = '⚠️';
      message = `Due in 2 days — ${remaining} task${remaining !== 1 ? 's' : ''} remaining`;
    } else if (daysLeft === 3) {
      urgency = 'warning'; icon = '📅';
      message = `Due in 3 days — ${remaining} of ${totalCnt} tasks pending`;
    } else {
      return;
    }

    notifications.push({
      id: ver.id,
      urgency, icon,
      title: `${projectName} · ${ver.name}`,
      message, daysLeft,
      projectName,
      projectId: ver.projectId,
      read: _readNotifIds.has(ver.id),
    });
  });

  // Any version that was unread and is now all-done → auto-clear from read set
  // (so if tasks change it shows fresh again)
  // Unread first, then most urgent (lowest daysLeft) within each group
  notifications.sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1; // unread before read
    return a.daysLeft - b.daysLeft;                 // most urgent first
  });
  return notifications;
}

function _buildNotifDropdown(notifs) {
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;

  const unreadNotifs = notifs.filter(n => !n.read);
  const hasUnread = unreadNotifs.length > 0;

  // Show first 3 inline, rest in "show more"
  const INLINE_LIMIT = 3;

  if (notifs.length === 0) {
    dropdown.innerHTML = `<div class="notif-empty">✅ No reminders — you're all caught up!</div>`;
    return;
  }

  const renderItem = (n) => `
    <div class="notif-item${n.read ? ' read' : ''}" data-notif-id="${n.id}">
      <div class="notif-item-icon ${n.urgency}">${n.icon}</div>
      <div class="notif-item-body">
        <div class="notif-item-title">${n.title}</div>
        <div class="notif-item-desc">${n.message}</div>
      </div>
      ${!n.read ? `<button class="notif-read-btn" title="Mark as read" data-read-id="${n.id}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/>
          <path d="M4.5 7l2 2 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>` : '<span class="notif-read-done" title="Read">✓</span>'}
    </div>`;

  const visibleItems = notifs.slice(0, INLINE_LIMIT);
  const hiddenCount = notifs.length - INLINE_LIMIT;

  dropdown.innerHTML = `
    <div class="notif-dropdown-header">
      <span>🔔 Reminders ${hasUnread ? `<span class="notif-unread-badge">${unreadNotifs.length} new</span>` : ''}</span>
      <div style="display:flex;gap:6px;align-items:center">
        ${hasUnread ? `<button class="notif-clear-btn" id="notif-mark-all-read">Mark all read</button>` : ''}
        <button class="notif-clear-btn" id="notif-go-planner">View Planner</button>
      </div>
    </div>
    ${visibleItems.map(renderItem).join('')}
    ${hiddenCount > 0 ? `
      <div class="notif-show-more-bar">
        <button class="notif-show-more-btn" id="notif-show-all-btn">
          Show ${hiddenCount} more ▾
        </button>
      </div>` : ''}`;

  // Show all → open centered modal
  dropdown.querySelector('#notif-show-all-btn')?.addEventListener('click', () => {
    dropdown.style.display = 'none';
    openNotifModal();
  });

  // Mark all read
  dropdown.querySelector('#notif-mark-all-read')?.addEventListener('click', () => {
    notifs.forEach(n => _readNotifIds.add(n.id));
    _saveReadNotifIds();
    renderNotifBell();
  });

  // Individual mark-read buttons
  dropdown.querySelectorAll('.notif-read-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _readNotifIds.add(btn.dataset.readId);
      _saveReadNotifIds();
      renderNotifBell();
    });
  });

  // Go to planner
  dropdown.querySelector('#notif-go-planner')?.addEventListener('click', () => {
    dropdown.style.display = 'none';
    document.querySelector('[data-page="planner"]')?.click();
  });
}

// ── All-Notifications Modal ────────────────────────────────────────────────────
function openNotifModal() {
  document.getElementById('notif-modal-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'notif-modal-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;
    display:flex;align-items:center;justify-content:center;
    animation:fadeIn .15s ease;
  `;

  const allNotifs = getVersionNotifications();
  const projectMap = {};
  allNotifs.forEach(n => { if (n.projectId) projectMap[n.projectId] = n.projectName; });
  const projectOptions = Object.entries(projectMap)
    .map(([id, name]) => `<option value="${id}">${name}</option>`)
    .join('');

  overlay.innerHTML = `
    <div style="
      background:#1a1a24;border:1px solid #ffffff14;border-radius:16px;
      width:500px;max-width:92vw;max-height:78vh;display:flex;flex-direction:column;
      box-shadow:0 24px 64px #00000090;animation:slideUp .2s ease;overflow:hidden;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;
                  padding:16px 20px 14px;border-bottom:1px solid #ffffff0f;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">🔔</span>
          <div>
            <div style="font-size:15px;font-weight:700;color:#f0f0f5;">All Reminders</div>
            <div style="font-size:11px;color:#55556a;margin-top:1px;" id="nmod-count-label"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button id="nmod-mark-all" style="
            background:none;border:1px solid #ffffff14;border-radius:7px;
            color:#7c6af7;font-size:11.5px;font-weight:600;padding:5px 10px;
            cursor:pointer;transition:background .15s;display:none;">Mark all read</button>
          <button id="nmod-close" style="
            background:none;border:none;cursor:pointer;color:#55556a;
            font-size:19px;line-height:1;padding:3px 7px;border-radius:6px;
            transition:color .15s,background .15s;">✕</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:10px 20px;
                  border-bottom:1px solid #ffffff0f;flex-shrink:0;flex-wrap:wrap;">
        <div style="display:flex;background:#0f0f17;border-radius:8px;padding:2px;gap:2px;" id="nmod-tabs">
          <button class="nmod-tab" data-tab="all">All</button>
          <button class="nmod-tab" data-tab="unread">Unread</button>
          <button class="nmod-tab" data-tab="read">Read</button>
        </div>
        ${projectOptions ? `
        <select id="nmod-project-filter" style="
          flex:1;min-width:130px;background:#0f0f17;border:1px solid #ffffff12;
          border-radius:8px;color:#f0f0f5;font-size:12px;padding:5px 10px;
          cursor:pointer;outline:none;">
          <option value="">All projects</option>
          ${projectOptions}
        </select>` : ''}
      </div>
      <div id="nmod-list" style="overflow-y:auto;flex:1;padding:4px 0;min-height:60px;"></div>
    </div>`;

  document.body.appendChild(overlay);

  function styleTab(btn, active) {
    btn.style.cssText = `
      background:${active ? '#7c6af720' : 'none'};border:none;cursor:pointer;
      color:${active ? '#7c6af7' : '#8888aa'};font-size:11.5px;
      font-weight:${active ? '700' : '500'};padding:4px 12px;
      border-radius:6px;transition:all .15s;`;
  }
  overlay.querySelectorAll('.nmod-tab').forEach(t => styleTab(t, t.dataset.tab === 'all'));

  let activeTab = 'all';
  let activeProject = '';

  function applyFilters() {
    const notifs = getVersionNotifications();
    let filtered = notifs;
    if (activeTab === 'unread') filtered = filtered.filter(n => !n.read);
    if (activeTab === 'read') filtered = filtered.filter(n => n.read);
    if (activeProject) filtered = filtered.filter(n => n.projectId === activeProject);
    renderModalList(filtered, notifs);
  }

  function renderModalList(filtered, allN) {
    const list = document.getElementById('nmod-list');
    const label = document.getElementById('nmod-count-label');
    const markAllBtn = document.getElementById('nmod-mark-all');
    if (!list) return;

    const unreadAll = allN.filter(n => !n.read);
    if (markAllBtn) markAllBtn.style.display = unreadAll.length > 0 ? '' : 'none';
    if (label) {
      const suffix = (activeTab !== 'all' || activeProject) ? ' (filtered)' : '';
      label.textContent = `${filtered.length} reminder${filtered.length !== 1 ? 's' : ''}${suffix}`;
    }

    if (filtered.length === 0) {
      const msgs = { read: '📭 No read notifications', unread: '✅ All caught up!', all: '✅ No reminders' };
      list.innerHTML = `<div style="padding:44px 20px;text-align:center;color:#55556a;font-size:13px;">${msgs[activeTab]}</div>`;
      return;
    }

    list.innerHTML = filtered.map(n => {
      const urgencyBg = n.urgency === 'urgent' ? '#ef444415' : n.urgency === 'warning' ? '#f59e0b15' : '#7c6af715';
      const badgeBg = n.urgency === 'urgent' ? '#ef444420' : '#f59e0b18';
      const badgeColor = n.urgency === 'urgent' ? '#f87171' : '#fbbf24';
      const badgeLabel = n.urgency === 'urgent'
        ? (n.daysLeft <= 0 ? 'OVERDUE' : 'DUE TOMORROW')
        : `${n.daysLeft}d LEFT`;
      return `
      <div class="nmod-item" data-id="${n.id}" style="
        display:flex;align-items:flex-start;gap:12px;padding:12px 20px;
        border-bottom:1px solid #ffffff06;cursor:default;transition:background .12s;
        opacity:${n.read ? '.4' : '1'};
      ">
        <div style="width:36px;height:36px;border-radius:10px;flex-shrink:0;
                    display:flex;align-items:center;justify-content:center;
                    font-size:16px;background:${urgencyBg};">${n.icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;font-weight:${n.read ? '400' : '700'};color:#f0f0f5;
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${n.title}</div>
          <div style="font-size:11.5px;color:${n.read ? '#55556a' : '#8888aa'};
                      margin-top:2px;line-height:1.4;">${n.message}</div>
          <div style="margin-top:5px;display:flex;align-items:center;gap:6px;">
            <span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;
                         border-radius:4px;background:${badgeBg};color:${badgeColor};">${badgeLabel}</span>
            <span style="font-size:10px;color:#55556a;">${n.projectName}</span>
          </div>
        </div>
        ${!n.read
          ? `<button class="nmod-read-btn" data-read-id="${n.id}" title="Mark as read" style="
               flex-shrink:0;background:none;border:1px solid #ffffff15;border-radius:7px;
               cursor:pointer;color:#7c6af7;width:28px;height:28px;
               display:flex;align-items:center;justify-content:center;
               transition:background .15s;margin-top:2px;">
               <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                 <circle cx="7" cy="7" r="6" stroke="currentColor" stroke-width="1.3"/>
                 <path d="M4.5 7l2 2 3-3" stroke="currentColor" stroke-width="1.4"
                       stroke-linecap="round" stroke-linejoin="round"/>
               </svg>
             </button>`
          : `<span style="color:#22c55e;font-size:13px;flex-shrink:0;padding:0 4px;margin-top:4px;">✓</span>`}
      </div>`;
    }).join('');

    list.querySelectorAll('.nmod-item').forEach(row => {
      row.addEventListener('mouseenter', () => { row.style.background = '#ffffff04'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
    });
    list.querySelectorAll('.nmod-read-btn').forEach(btn => {
      btn.addEventListener('mouseenter', () => { btn.style.background = '#7c6af715'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _readNotifIds.add(btn.dataset.readId);
        _saveReadNotifIds();
        renderNotifBell();
        applyFilters();
      });
    });
  }

  overlay.querySelectorAll('.nmod-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      overlay.querySelectorAll('.nmod-tab').forEach(t => styleTab(t, t === tab));
      applyFilters();
    });
  });

  overlay.querySelector('#nmod-project-filter')?.addEventListener('change', (e) => {
    activeProject = e.target.value;
    applyFilters();
  });

  overlay.querySelector('#nmod-mark-all')?.addEventListener('click', () => {
    getVersionNotifications().forEach(n => _readNotifIds.add(n.id));
    _saveReadNotifIds();
    renderNotifBell();
    applyFilters();
  });

  const close = () => overlay.remove();
  overlay.querySelector('#nmod-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  const closeBtn = overlay.querySelector('#nmod-close');
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = '#f0f0f5'; closeBtn.style.background = '#ffffff10'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = '#55556a'; closeBtn.style.background = 'none'; });
  const markAllBtn2 = overlay.querySelector('#nmod-mark-all');
  if (markAllBtn2) {
    markAllBtn2.addEventListener('mouseenter', () => { markAllBtn2.style.background = '#7c6af715'; });
    markAllBtn2.addEventListener('mouseleave', () => { markAllBtn2.style.background = 'none'; });
  }

  applyFilters();
}

function renderNotifBell() {
  const btn = document.getElementById('notif-bell-btn');
  const dot = document.getElementById('notif-dot');
  const dropdown = document.getElementById('notif-dropdown');
  if (!btn) return;

  const notifs = getVersionNotifications();
  const unread = notifs.filter(n => !n.read);
  const hasUnread = unread.length > 0;
  const wasActive = btn.classList.contains('has-notifs');

  // ── Badge (! dot) ─────────────────────────────────────────────────────────
  if (hasUnread) {
    // Force the pop animation to replay every time we show the badge by
    // briefly removing the element from layout (void reflow trick).
    dot.style.display = 'block';
    dot.style.animation = 'none';
    void dot.offsetWidth; // trigger reflow
    dot.style.animation = '';
  } else {
    dot.style.display = 'none';
  }

  // ── Bell shake ───────────────────────────────────────────────────────────
  if (hasUnread) {
    // If the class was already present the CSS animation is already running —
    // no restart needed. Only restart when transitioning from no-notifs → notifs.
    if (!wasActive) {
      const icon = btn.querySelector('.notif-bell-icon');
      if (icon) {
        icon.style.animation = 'none';
        void icon.offsetWidth;
        icon.style.animation = '';
      }
    }
    btn.classList.add('has-notifs');
  } else {
    btn.classList.remove('has-notifs');
  }

  // Rebuild dropdown if it's currently open
  if (dropdown.style.display === 'block') {
    _buildNotifDropdown(notifs);
  }
}

function initNotifBell() {
  const btn = document.getElementById('notif-bell-btn');
  const dropdown = document.getElementById('notif-dropdown');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dropdown.style.display === 'block';
    dropdown.style.display = open ? 'none' : 'block';
    if (!open) {
      const notifs = getVersionNotifications();
      _buildNotifDropdown(notifs);
    }
  });

  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
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
    <div class="report-total-label">Total Work Time — ${new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
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

// ── Report view state ─────────────────────────────────────────────────────────
let reportView = 'daily'; // 'daily' | 'weekly' | 'monthly'
let reportWeekOffset = 0;  // 0 = current week, -1 = last week, etc.
let reportMonthOffset = 0; // 0 = current month

// Returns array of YYYY-MM-DD strings for the Mon–Sun week at weekOffset from today
function getWeekDates(weekOffset) {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMon + weekOffset * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(localDateStr(d));
  }
  return dates;
}

// Returns array of YYYY-MM-DD strings for every day of the month at monthOffset
function getMonthDates(monthOffset) {
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = target.getFullYear();
  const month = target.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const dates = [];
  for (let d = 1; d <= days; d++) {
    dates.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return dates;
}

// Aggregate sessions for a list of dates → { date: { totalMs, taskCount, sessionCount } }
function aggregateDates(dates) {
  const map = {};
  dates.forEach(d => { map[d] = { totalMs: 0, taskCount: 0, sessionCount: 0 }; });
  state.sessions.forEach(s => {
    if (map[s.date]) {
      map[s.date].totalMs += s.duration;
      map[s.date].sessionCount++;
    }
  });
  // unique tasks per day
  const taskSets = {};
  dates.forEach(d => { taskSets[d] = new Set(); });
  state.sessions.forEach(s => {
    if (taskSets[s.date]) taskSets[s.date].add(s.taskId);
  });
  dates.forEach(d => { map[d].taskCount = taskSets[d].size; });
  return map;
}

// Aggregate sessions by task across a list of dates → array sorted by totalMs desc
function aggregateTasksAcrossDates(dates) {
  const taskMap = {};
  state.sessions
    .filter(s => dates.includes(s.date))
    .forEach(s => {
      if (!taskMap[s.taskId]) {
        taskMap[s.taskId] = { name: s.taskName, totalMs: 0, sessionCount: 0, daysWorked: new Set() };
      }
      taskMap[s.taskId].totalMs += s.duration;
      taskMap[s.taskId].sessionCount++;
      taskMap[s.taskId].daysWorked.add(s.date);
    });
  return Object.values(taskMap)
    .sort((a, b) => b.totalMs - a.totalMs)
    .map(t => ({ ...t, daysWorked: t.daysWorked.size }));
}

function renderReportSummaryView(dates, labelFn, grandTotalLabel) {
  const dayMap = aggregateDates(dates);
  const taskSummary = aggregateTasksAcrossDates(dates);
  const todayDate = todayStr();
  const grandTotal = Object.values(dayMap).reduce((a, v) => a + v.totalMs, 0);
  const totalSessions = Object.values(dayMap).reduce((a, v) => a + v.sessionCount, 0);
  const workedDays = Object.values(dayMap).filter(v => v.totalMs > 0).length;
  const maxMs = Math.max(...Object.values(dayMap).map(v => v.totalMs), 1);

  // ── summary cards
  const summaryEl = document.getElementById('report-summary');
  summaryEl.innerHTML = `
    <div class="summary-card">
      <div class="summary-icon" style="background:#7c6af720">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#7c6af7" stroke-width="1.5"/><path d="M10 6v4l2.5 2.5" stroke="#7c6af7" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value">${formatDurationShort(grandTotal)}</div>
        <div class="summary-label">Total Time</div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-icon" style="background:#22d3ee20">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 15V8l6-5 6 5v7" stroke="#22d3ee" stroke-width="1.5" stroke-linecap="round"/><rect x="7" y="10" width="6" height="5" rx="1" stroke="#22d3ee" stroke-width="1.5"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value">${workedDays}</div>
        <div class="summary-label">Days Worked</div>
      </div>
    </div>
    <div class="summary-card">
      <div class="summary-icon" style="background:#f59e0b20">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v6l3 3" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="10" r="8" stroke="#f59e0b" stroke-width="1.5"/></svg>
      </div>
      <div class="summary-data">
        <div class="summary-value">${workedDays > 0 ? formatDurationShort(Math.round(grandTotal / workedDays)) : '—'}</div>
        <div class="summary-label">Daily Average</div>
      </div>
    </div>
  `;

  // ── hide daily table, show summary view
  document.getElementById('report-table').closest('.report-table-wrapper').style.display = 'none';
  const sv = document.getElementById('report-summary-view');
  sv.style.display = '';

  // Day-by-day bar rows
  const rowsHtml = dates.map(d => {
    const v = dayMap[d];
    const pct = maxMs > 0 ? Math.max((v.totalMs / maxMs) * 100, v.totalMs > 0 ? 2 : 0) : 0;
    const isToday = d === todayDate;
    const label = labelFn(d);
    return `
      <div class="summary-period-row${isToday ? ' is-today' : ''}">
        <div class="summary-period-date">${label}${isToday ? ' <span style="font-size:10px;color:#7c6af7;font-weight:700;">TODAY</span>' : ''}</div>
        <div class="summary-period-bar-wrap">
          <div class="summary-period-bar" style="width:${pct}%"></div>
        </div>
        ${v.totalMs > 0
        ? `<div class="summary-period-dur">${formatDurationShort(v.totalMs)}</div>
             <div class="summary-period-tasks">${v.taskCount} task${v.taskCount !== 1 ? 's' : ''}</div>`
        : `<div class="summary-period-dur" style="color:#ffffff20">—</div>
             <div class="summary-period-tasks summary-period-empty">no work</div>`
      }
      </div>`;
  }).join('');

  // Top tasks table
  const topTasksHtml = taskSummary.length === 0
    ? `<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No sessions in this period</div>`
    : `<table class="report-table" style="margin-top:0">
        <thead><tr>
          <th>Task</th>
          <th>Days Worked</th>
          <th>Sessions</th>
          <th>Total Time</th>
          <th>Share</th>
        </tr></thead>
        <tbody>
          ${taskSummary.map(t => {
      const pct = grandTotal > 0 ? ((t.totalMs / grandTotal) * 100).toFixed(1) : '0.0';
      return `<tr>
              <td><strong>${t.name}</strong></td>
              <td style="color:var(--text-secondary)">${t.daysWorked}</td>
              <td style="color:var(--text-secondary)">${t.sessionCount}</td>
              <td style="font-family:var(--font-mono);font-size:12px;color:#a78bfa">${formatDurationShort(t.totalMs)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="flex:1;height:5px;background:#ffffff08;border-radius:3px;overflow:hidden;min-width:60px">
                    <div style="height:100%;border-radius:3px;background:#7c6af7;width:${pct}%"></div>
                  </div>
                  <span style="font-size:11px;color:var(--text-muted);min-width:36px">${pct}%</span>
                </div>
              </td>
            </tr>`;
    }).join('')}
        </tbody>
      </table>`;

  sv.innerHTML = `
    <div class="summary-period-grid">${rowsHtml}</div>
    <div style="margin-top:20px">
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px;">Task Breakdown</div>
      <div class="report-table-wrapper" style="margin-bottom:0">${topTasksHtml}</div>
    </div>
  `;

  // ── total bar
  document.getElementById('report-total').innerHTML = `
    <div class="report-total-label">${grandTotalLabel}</div>
    <div class="report-total-value">${formatDurationShort(grandTotal)}</div>
  `;
}

function renderReportWeekly() {
  const dates = getWeekDates(reportWeekOffset);
  const weekStart = new Date(dates[0] + 'T00:00:00');
  const weekEnd = new Date(dates[6] + 'T00:00:00');
  const fmtOpts = { month: 'short', day: 'numeric' };
  const rangeLabel = `${weekStart.toLocaleDateString([], fmtOpts)} – ${weekEnd.toLocaleDateString([], { ...fmtOpts, year: 'numeric' })}`;

  // Update nav label
  document.getElementById('report-week-label').textContent = reportWeekOffset === 0 ? `(${rangeLabel})` : rangeLabel;

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  renderReportSummaryView(
    dates,
    (d) => {
      const dt = new Date(d + 'T00:00:00');
      const idx = dates.indexOf(d);
      return `${dayNames[idx]}  ${dt.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    },
    `Total — Week of ${weekStart.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`
  );
}

function renderReportMonthly() {
  const dates = getMonthDates(reportMonthOffset);
  const ref = new Date(dates[0] + 'T00:00:00');
  const monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });

  document.getElementById('report-month-label').textContent = monthName;

  renderReportSummaryView(
    dates,
    (d) => {
      const dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    },
    `Total — ${monthName}`
  );
}

function switchReportView(view) {
  reportView = view;
  // Sync dropdown
  const sel = document.getElementById('report-view-select');
  if (sel) sel.value = view;
  // Show/hide controls
  document.getElementById('report-date').style.display = view === 'daily' ? '' : 'none';
  document.getElementById('report-week-nav').style.display = view === 'weekly' ? 'flex' : 'none';
  document.getElementById('report-month-nav').style.display = view === 'monthly' ? 'flex' : 'none';

  if (view === 'daily') {
    // Restore daily view
    document.getElementById('report-table').closest('.report-table-wrapper').style.display = '';
    document.getElementById('report-summary-view').style.display = 'none';
    renderReport(document.getElementById('report-date').value);
  } else if (view === 'weekly') {
    renderReportWeekly();
  } else {
    renderReportMonthly();
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
  text += `Date: ${new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
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

function generateReportTextWeekly() {
  const dates = getWeekDates(reportWeekOffset);
  const weekStart = new Date(dates[0] + 'T00:00:00');
  const weekEnd = new Date(dates[6] + 'T00:00:00');
  const fmtOpts = { month: 'short', day: 'numeric' };
  const rangeLabel = `${weekStart.toLocaleDateString([], fmtOpts)} – ${weekEnd.toLocaleDateString([], { ...fmtOpts, year: 'numeric' })}`;

  const dayMap = aggregateDates(dates);
  const taskSummary = aggregateTasksAcrossDates(dates);
  const grandTotal = Object.values(dayMap).reduce((a, v) => a + v.totalMs, 0);
  const workedDays = Object.values(dayMap).filter(v => v.totalMs > 0).length;
  const totalSessions = Object.values(dayMap).reduce((a, v) => a + v.sessionCount, 0);
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let text = `WorkTracker Weekly Report\n`;
  text += `Week: ${rangeLabel}\n`;
  text += `Generated: ${new Date().toLocaleString()}\n`;
  text += '═'.repeat(60) + '\n\n';

  text += `SUMMARY\n`;
  text += `  Total Work Time : ${formatDurationShort(grandTotal)}\n`;
  text += `  Days Worked     : ${workedDays} / 7\n`;
  text += `  Total Sessions  : ${totalSessions}\n`;
  text += `  Daily Average   : ${workedDays > 0 ? formatDurationShort(Math.round(grandTotal / workedDays)) : '—'}\n`;
  text += '\n' + '─'.repeat(60) + '\n\n';

  text += `DAY-BY-DAY BREAKDOWN\n\n`;
  dates.forEach((d, i) => {
    const v = dayMap[d];
    const label = `${dayNames[i]}  ${new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    const bar = v.totalMs > 0 ? '█'.repeat(Math.round((v.totalMs / (grandTotal || 1)) * 20)) : '░'.repeat(20);
    text += `  ${label.padEnd(14)} ${bar}  ${v.totalMs > 0 ? formatDurationShort(v.totalMs) : 'No work'}\n`;
    if (v.taskCount > 0) text += `                   Tasks: ${v.taskCount}  Sessions: ${v.sessionCount}\n`;
  });
  text += '\n' + '─'.repeat(60) + '\n\n';

  if (taskSummary.length > 0) {
    text += `TASK BREAKDOWN\n\n`;
    taskSummary.forEach(t => {
      const pct = grandTotal > 0 ? ((t.totalMs / grandTotal) * 100).toFixed(1) : '0.0';
      text += `  Task: ${t.name}\n`;
      text += `    Total Time  : ${formatDurationShort(t.totalMs)}  (${pct}%)\n`;
      text += `    Days Worked : ${t.daysWorked}\n`;
      text += `    Sessions    : ${t.sessionCount}\n`;
      text += '  ' + '─'.repeat(40) + '\n';
    });
  }

  text += `\nTOTAL WORK TIME: ${formatDurationShort(grandTotal)}\n`;
  return text;
}

function generateReportTextMonthly() {
  const dates = getMonthDates(reportMonthOffset);
  const ref = new Date(dates[0] + 'T00:00:00');
  const monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });

  const dayMap = aggregateDates(dates);
  const taskSummary = aggregateTasksAcrossDates(dates);
  const grandTotal = Object.values(dayMap).reduce((a, v) => a + v.totalMs, 0);
  const workedDays = Object.values(dayMap).filter(v => v.totalMs > 0).length;
  const totalSessions = Object.values(dayMap).reduce((a, v) => a + v.sessionCount, 0);

  let text = `WorkTracker Monthly Report\n`;
  text += `Month: ${monthName}\n`;
  text += `Generated: ${new Date().toLocaleString()}\n`;
  text += '═'.repeat(60) + '\n\n';

  text += `SUMMARY\n`;
  text += `  Total Work Time : ${formatDurationShort(grandTotal)}\n`;
  text += `  Days Worked     : ${workedDays} / ${dates.length}\n`;
  text += `  Total Sessions  : ${totalSessions}\n`;
  text += `  Daily Average   : ${workedDays > 0 ? formatDurationShort(Math.round(grandTotal / workedDays)) : '—'}\n`;
  text += '\n' + '─'.repeat(60) + '\n\n';

  text += `DAY-BY-DAY BREAKDOWN\n\n`;
  dates.forEach(d => {
    const v = dayMap[d];
    if (v.totalMs === 0) return; // skip empty days in monthly to keep it concise
    const label = new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const bar = '█'.repeat(Math.round((v.totalMs / (grandTotal || 1)) * 20));
    text += `  ${label.padEnd(14)} ${bar}  ${formatDurationShort(v.totalMs)}\n`;
    text += `                   Sessions: ${v.sessionCount}  Tasks: ${v.taskCount}\n`;
  });
  if (workedDays === 0) text += `  No work sessions recorded this month.\n`;
  text += '\n' + '─'.repeat(60) + '\n\n';

  if (taskSummary.length > 0) {
    text += `TASK BREAKDOWN\n\n`;
    taskSummary.forEach(t => {
      const pct = grandTotal > 0 ? ((t.totalMs / grandTotal) * 100).toFixed(1) : '0.0';
      text += `  Task: ${t.name}\n`;
      text += `    Total Time  : ${formatDurationShort(t.totalMs)}  (${pct}%)\n`;
      text += `    Days Worked : ${t.daysWorked}\n`;
      text += `    Sessions    : ${t.sessionCount}\n`;
      text += '  ' + '─'.repeat(40) + '\n';
    });
  }

  text += `\nTOTAL WORK TIME: ${formatDurationShort(grandTotal)}\n`;
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

function editTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  document.getElementById('edit-task-id').value = taskId;
  document.getElementById('edit-task-name').value = task.name;
  document.getElementById('edit-task-category').value = task.category || 'work';
  document.getElementById('edit-task-notes').value = task.notes || '';
  document.getElementById('edit-modal-overlay').style.display = 'flex';
  setTimeout(() => document.getElementById('edit-task-name').focus(), 50);
}

function hideEditModal() {
  document.getElementById('edit-modal-overlay').style.display = 'none';
}

function saveEditTask() {
  const taskId = document.getElementById('edit-task-id').value;
  const name = document.getElementById('edit-task-name').value.trim();
  const category = document.getElementById('edit-task-category').value;
  const notes = document.getElementById('edit-task-notes').value.trim();

  if (!name) {
    document.getElementById('edit-task-name').focus();
    return;
  }

  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  task.name = name;
  task.category = category;
  task.notes = notes;

  // Keep session taskName in sync for any sessions already saved today
  state.sessions.forEach(s => {
    if (s.taskId === taskId) s.taskName = name;
  });

  saveData();
  renderAll();
  hideEditModal();
  showNotif(`Task updated: ${name}`, 'success');
}

// ── Notifications ─────────────────────────────────────────────────────────────
function showNotif(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notification ${type}`;
  el.textContent = msg;
  el.title = msg; // show full text on hover if truncated
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

  if (page === 'report') {
    if (reportView === 'daily') renderReport();
    else if (reportView === 'weekly') renderReportWeekly();
    else renderReportMonthly();
  }
  if (page === 'calendar') renderCalendar().catch(console.error);
}

async function loadSettings() {
  const settings = await api.loadSettings();
  document.getElementById('toggle-startup').checked = settings.startWithWindows || false;

  if (settings.country) {
    selectedCountry = settings.country;
    document.getElementById('select-country').value = settings.country;
  }

  // Restore notification read state so the bell doesn't re-shake after restart
  if (Array.isArray(settings.readNotifIds)) {
    settings.readNotifIds.forEach(id => _readNotifIds.add(id));
  }

  // Tray timer toggle
  const trayTimerEnabled = settings.trayTimerEnabled === true;
  document.getElementById('toggle-tray-timer').checked = trayTimerEnabled;
  if (api.setTrayTimerEnabled) api.setTrayTimerEnabled(trayTimerEnabled);

  document.getElementById('toggle-tray-timer').addEventListener('change', async (e) => {
    const settings = await api.loadSettings();
    settings.trayTimerEnabled = e.target.checked;
    await api.saveSettings(settings);
    if (api.setTrayTimerEnabled) api.setTrayTimerEnabled(e.target.checked);
    showNotif(`Tray timer ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
  });

  document.getElementById('select-country').addEventListener('change', async (e) => {
    selectedCountry = e.target.value;
    const settings = await api.loadSettings();
    settings.country = e.target.value;
    await api.saveSettings(settings);
    const tz = COUNTRY_TIMEZONE[e.target.value] || 'system default';
    showNotif(`Timezone set to ${e.target.options[e.target.selectedIndex].text} (${tz})`, 'info');
    renderAll();
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
  if (reportView === 'weekly') {
    await _exportReportWeekly(format);
  } else if (reportView === 'monthly') {
    await _exportReportMonthly(format);
  } else {
    await _exportReportDaily(format);
  }
}

// ── Shared PDF helpers ────────────────────────────────────────────────────────
function _pdfHeader(doc, title, subtitle) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(30, 20, 60);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 20, 17);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, pageW - 20, 17, { align: 'right' });
}

function _pdfSummaryBox(doc, y, col1, col2, col3) {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 20;
  doc.setFillColor(245, 245, 255);
  doc.roundedRect(margin, y, pageW - margin * 2, 12, 3, 3, 'F');
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(60, 60, 60);
  doc.text(col1, margin + 6, y + 8);
  doc.text(col2, pageW / 2, y + 8, { align: 'center' });
  doc.text(col3, pageW - margin - 6, y + 8, { align: 'right' });
  return y + 18;
}

function _pdfSectionTitle(doc, y, text) {
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(124, 106, 247);
  doc.roundedRect(20, y, pageW - 40, 7, 2, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text(text, 25, y + 5);
  return y + 12;
}

function _pdfFooter(doc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, pageH - 14, pageW - margin, pageH - 14);
  doc.setFontSize(7.5);
  doc.setTextColor(160, 160, 160);
  doc.setFont('helvetica', 'normal');
  doc.text('Generated by WorkTracker', margin, pageH - 8);
  doc.text(new Date().toLocaleString(), pageW - margin, pageH - 8, { align: 'right' });
}

// ── Daily export ──────────────────────────────────────────────────────────────
async function _exportReportDaily(format) {
  const date = document.getElementById('report-date').value;
  const dateStr = date || todayStr();

  if (format === 'txt') {
    const content = generateReportText(dateStr);
    const filepath = await api.exportReport({ content, filename: `worktracker-daily-${dateStr}.txt`, folder: 'Reports' });
    showNotif(`Report saved: ${filepath}`, 'success');
    return;
  }

  // PDF — original design (Image 1 style)
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  let y = margin;

  const checkPage = (needed = 10) => {
    if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
  };

  const d = dateStr;

  // ── Header bar (deep navy)
  doc.setFillColor(30, 20, 60);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('WorkTracker Report', margin, 18);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(
    new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    pageW - margin, 18, { align: 'right' }
  );
  y = 40;

  // ── Generated timestamp
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 12;

  // ── Build task data
  const sessions = state.sessions.filter(s => s.date === d);
  const taskMap = {};
  sessions.forEach(s => {
    if (!taskMap[s.taskId]) taskMap[s.taskId] = { name: s.taskName, sessions: [], totalMs: 0 };
    taskMap[s.taskId].sessions.push(s);
    taskMap[s.taskId].totalMs += s.duration;
  });
  const grandTotal = Object.values(taskMap).reduce((a, t) => a + t.totalMs, 0);

  // ── Summary box (light lavender)
  doc.setFillColor(245, 245, 255);
  doc.roundedRect(margin, y, pageW - margin * 2, 12, 3, 3, 'F');
  doc.setTextColor(60, 60, 60);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(`Total Work Time: ${formatDurationShort(grandTotal)}`, margin + 6, y + 8);
  doc.text(`Tasks: ${Object.keys(taskMap).length}`, pageW / 2, y + 8, { align: 'center' });
  doc.text(`Sessions: ${sessions.length}`, pageW - margin - 6, y + 8, { align: 'right' });
  y += 18;

  // ── Table header (solid purple)
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
    doc.text(doc.splitTextToSize(data.name, cols[1] - cols[0] - 2)[0], cols[0], y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(80, 80, 80);
    doc.text(String(data.sessions.length), cols[1], y + 6);
    doc.text(first ? formatTime(first.startTime) : '—', cols[2], y + 6);
    doc.text(last?.endTime ? formatTime(last.endTime) : 'Running', cols[3], y + 6);
    doc.setTextColor(100, 80, 220);
    doc.setFont('helvetica', 'bold');
    doc.text(formatDurationShort(data.totalMs), cols[4], y + 6);
    y += 9;
    rowIndex++;
  });

  if (Object.keys(taskMap).length === 0) {
    doc.setTextColor(180, 180, 180);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('No sessions recorded for this day.', margin + 4, y + 8);
    y += 16;
  }

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
  doc.text('Page 1', pageW - margin, y, { align: 'right' });

  const base64 = btoa(String.fromCharCode(...new Uint8Array(doc.output('arraybuffer'))));
  const filepath = await api.exportReport({ content: base64, filename: `worktracker-daily-${dateStr}.pdf`, isPdf: true, folder: 'Reports' });
  showNotif(`PDF saved: ${filepath}`, 'success');
}

// ── Weekly export ─────────────────────────────────────────────────────────────
async function _exportReportWeekly(format) {
  const dates = getWeekDates(reportWeekOffset);
  const weekStart = new Date(dates[0] + 'T00:00:00');
  const weekEnd = new Date(dates[6] + 'T00:00:00');
  const fmtOpts = { month: 'short', day: 'numeric' };
  const rangeLabel = `${weekStart.toLocaleDateString([], fmtOpts)}–${weekEnd.toLocaleDateString([], { ...fmtOpts, year: 'numeric' })}`;
  const fileSlug = `${dates[0]}_${dates[6]}`;

  if (format === 'txt') {
    const content = generateReportTextWeekly();
    const filepath = await api.exportReport({ content, filename: `worktracker-weekly-${fileSlug}.txt`, folder: 'Reports' });
    showNotif(`Report saved: ${filepath}`, 'success');
    return;
  }

  // PDF
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  let y = margin;

  const checkPage = (needed = 10) => {
    if (y + needed > pageH - margin - 16) { doc.addPage(); y = margin; }
  };

  _pdfHeader(doc, 'WorkTracker Weekly Report', rangeLabel);
  y = 38;

  doc.setTextColor(100, 100, 100);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 10;

  const dayMap = aggregateDates(dates);
  const taskSummary = aggregateTasksAcrossDates(dates);
  const grandTotal = Object.values(dayMap).reduce((a, v) => a + v.totalMs, 0);
  const workedDays = Object.values(dayMap).filter(v => v.totalMs > 0).length;
  const totalSess = Object.values(dayMap).reduce((a, v) => a + v.sessionCount, 0);
  const dailyAvg = workedDays > 0 ? Math.round(grandTotal / workedDays) : 0;

  y = _pdfSummaryBox(doc, y,
    `Total: ${formatDurationShort(grandTotal)}`,
    `${workedDays}/7 days worked`,
    `Avg/day: ${workedDays > 0 ? formatDurationShort(dailyAvg) : '—'}`);

  // ── Day-by-day bar chart ───────────────────────────────────────────────────
  y = _pdfSectionTitle(doc, y, 'DAY-BY-DAY BREAKDOWN');
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const maxMs = Math.max(...Object.values(dayMap).map(v => v.totalMs), 1);
  const barMaxW = pageW - margin * 2 - 50;

  dates.forEach((d, i) => {
    checkPage(10);
    const v = dayMap[d];
    const label = `${dayNames[i]}  ${new Date(d + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    const barW = v.totalMs > 0 ? Math.max((v.totalMs / maxMs) * barMaxW, 3) : 0;

    // Label — plain style for all days, no today highlight
    doc.setTextColor(60, 60, 60);
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.text(label, margin, y + 5);

    // Bar track
    const barX = margin + 32;
    doc.setFillColor(240, 240, 248);
    doc.roundedRect(barX, y + 1, barMaxW, 5, 1, 1, 'F');

    // Bar fill
    if (barW > 0) {
      doc.setFillColor(124, 106, 247);
      doc.roundedRect(barX, y + 1, barW, 5, 1, 1, 'F');
    }

    // Duration text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(v.totalMs > 0 ? 80 : 180, v.totalMs > 0 ? 60 : 180, v.totalMs > 0 ? 180 : 180);
    doc.text(v.totalMs > 0 ? formatDurationShort(v.totalMs) : '—', barX + barMaxW + 3, y + 5.5);

    y += 10;
  });

  y += 4;

  // Build flat rows: one row per (task, date) pair
  const taskDateRows = [];
  dates.forEach(d => {
    const daySessions = state.sessions.filter(s => s.date === d);
    const taskMapDay = {};
    daySessions.forEach(s => {
      if (!taskMapDay[s.taskId]) taskMapDay[s.taskId] = { name: s.taskName, totalMs: 0 };
      taskMapDay[s.taskId].totalMs += s.duration;
    });
    Object.values(taskMapDay).forEach(t => {
      taskDateRows.push({
        name: t.name,
        date: new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        totalMs: t.totalMs,
      });
    });
  });

  if (taskDateRows.length === 0) {
    doc.setTextColor(180, 180, 180);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('No sessions recorded this week.', margin + 4, y + 6);
    y += 14;
  } else {
    // Table header (solid purple, matches daily style)
    doc.setFillColor(124, 106, 247);
    doc.rect(margin, y, pageW - margin * 2, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const tcols = [margin + 3, 120, 165];
    doc.text('TASK', tcols[0], y + 5.5);
    doc.text('DATE', tcols[1], y + 5.5);
    doc.text('DURATION', tcols[2], y + 5.5);
    y += 8;

    taskDateRows.forEach((row, i) => {
      checkPage(9);
      if (i % 2 === 0) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, pageW - margin * 2, 9, 'F');
      }
      doc.setTextColor(30, 30, 30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(doc.splitTextToSize(row.name, tcols[1] - tcols[0] - 4)[0], tcols[0], y + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(80, 80, 80);
      doc.text(row.date, tcols[1], y + 6);
      doc.setTextColor(100, 80, 220);
      doc.setFont('helvetica', 'bold');
      doc.text(formatDurationShort(row.totalMs), tcols[2], y + 6);
      y += 9;
    });
  }

  _pdfFooter(doc);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(doc.output('arraybuffer'))));
  const filepath = await api.exportReport({ content: base64, filename: `worktracker-weekly-${fileSlug}.pdf`, isPdf: true, folder: 'Reports' });
  showNotif(`PDF saved: ${filepath}`, 'success');
}

// ── Monthly export ────────────────────────────────────────────────────────────
async function _exportReportMonthly(format) {
  const dates = getMonthDates(reportMonthOffset);
  const ref = new Date(dates[0] + 'T00:00:00');
  const monthName = ref.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const fileSlug = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;

  if (format === 'txt') {
    const content = generateReportTextMonthly();
    const filepath = await api.exportReport({ content, filename: `worktracker-monthly-${fileSlug}.txt`, folder: 'Reports' });
    showNotif(`Report saved: ${filepath}`, 'success');
    return;
  }

  // PDF
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  let y = margin;

  const checkPage = (needed = 10) => {
    if (y + needed > pageH - margin - 16) { doc.addPage(); y = margin; }
  };

  _pdfHeader(doc, 'WorkTracker Monthly Report', monthName);
  y = 38;

  doc.setTextColor(100, 100, 100);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 10;

  const dayMap = aggregateDates(dates);
  const taskSummary = aggregateTasksAcrossDates(dates);
  const grandTotal = Object.values(dayMap).reduce((a, v) => a + v.totalMs, 0);
  const workedDays = Object.values(dayMap).filter(v => v.totalMs > 0).length;
  const totalSess = Object.values(dayMap).reduce((a, v) => a + v.sessionCount, 0);
  const dailyAvg = workedDays > 0 ? Math.round(grandTotal / workedDays) : 0;

  y = _pdfSummaryBox(doc, y,
    `Total: ${formatDurationShort(grandTotal)}`,
    `${workedDays}/${dates.length} days worked`,
    `Avg/day: ${workedDays > 0 ? formatDurationShort(dailyAvg) : '—'}`);

  // ── Day-by-day bar chart (worked days only) ────────────────────────────────
  y = _pdfSectionTitle(doc, y, 'DAY-BY-DAY BREAKDOWN (worked days only)');

  const maxMs = Math.max(...Object.values(dayMap).map(v => v.totalMs), 1);
  const barMaxW = pageW - margin * 2 - 55;

  const workedEntries = dates.filter(d => dayMap[d].totalMs > 0);
  if (workedEntries.length === 0) {
    doc.setTextColor(180, 180, 180);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('No sessions recorded this month.', margin + 4, y + 6);
    y += 14;
  } else {
    workedEntries.forEach(d => {
      checkPage(10);
      const v = dayMap[d];
      const label = new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      const barW = Math.max((v.totalMs / maxMs) * barMaxW, 3);

      // Plain style — no today highlight
      doc.setTextColor(60, 60, 60);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(label, margin, y + 5);

      const barX = margin + 36;
      doc.setFillColor(240, 240, 248);
      doc.roundedRect(barX, y + 1, barMaxW, 5, 1, 1, 'F');
      doc.setFillColor(124, 106, 247);
      doc.roundedRect(barX, y + 1, barW, 5, 1, 1, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(80, 60, 180);
      doc.text(formatDurationShort(v.totalMs), barX + barMaxW + 3, y + 5.5);

      y += 10;
    });
  }

  y += 4;

  // Build flat rows: one row per (task, date) pair
  const taskDateRows = [];
  dates.forEach(d => {
    const daySessions = state.sessions.filter(s => s.date === d);
    const taskMapDay = {};
    daySessions.forEach(s => {
      if (!taskMapDay[s.taskId]) taskMapDay[s.taskId] = { name: s.taskName, totalMs: 0 };
      taskMapDay[s.taskId].totalMs += s.duration;
    });
    Object.values(taskMapDay).forEach(t => {
      taskDateRows.push({
        name: t.name,
        date: new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
        totalMs: t.totalMs,
      });
    });
  });

  if (taskDateRows.length === 0) {
    doc.setTextColor(180, 180, 180);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text('No sessions recorded this month.', margin + 4, y + 6);
    y += 14;
  } else {
    // Table header (solid purple, matches daily/weekly style)
    doc.setFillColor(124, 106, 247);
    doc.rect(margin, y, pageW - margin * 2, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    const tcols = [margin + 3, 120, 165];
    doc.text('TASK', tcols[0], y + 5.5);
    doc.text('DATE', tcols[1], y + 5.5);
    doc.text('DURATION', tcols[2], y + 5.5);
    y += 8;

    taskDateRows.forEach((row, i) => {
      checkPage(9);
      if (i % 2 === 0) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, pageW - margin * 2, 9, 'F');
      }
      doc.setTextColor(30, 30, 30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(doc.splitTextToSize(row.name, tcols[1] - tcols[0] - 4)[0], tcols[0], y + 6);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(80, 80, 80);
      doc.text(row.date, tcols[1], y + 6);
      doc.setTextColor(100, 80, 220);
      doc.setFont('helvetica', 'bold');
      doc.text(formatDurationShort(row.totalMs), tcols[2], y + 6);
      y += 9;
    });
  }

  _pdfFooter(doc);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(doc.output('arraybuffer'))));
  const filepath = await api.exportReport({ content: base64, filename: `worktracker-monthly-${fileSlug}.pdf`, isPdf: true, folder: 'Reports' });
  showNotif(`PDF saved: ${filepath}`, 'success');
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
  await initFirebase();   // sets up auth listener first
  await loadData();
  await loadSettings();

  // Set today's date in report
  document.getElementById('report-date').value = todayStr();

  updateDateDisplay();
  setInterval(updateDateDisplay, 60000);

  autoCompleteOnStartup(); // auto-complete any task left running across midnight
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

  // Edit modal
  document.getElementById('edit-modal-close').addEventListener('click', hideEditModal);
  document.getElementById('btn-edit-modal-cancel').addEventListener('click', hideEditModal);
  document.getElementById('btn-edit-modal-save').addEventListener('click', saveEditTask);
  document.getElementById('edit-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'edit-modal-overlay') hideEditModal();
  });
  document.getElementById('edit-task-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveEditTask();
    if (e.key === 'Escape') hideEditModal();
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

  // Report view dropdown
  document.getElementById('report-view-select').addEventListener('change', (e) => {
    switchReportView(e.target.value);
  });

  // Week nav
  document.getElementById('btn-week-prev').addEventListener('click', () => {
    reportWeekOffset--;
    renderReportWeekly();
  });
  document.getElementById('btn-week-next').addEventListener('click', () => {
    reportWeekOffset++;
    renderReportWeekly();
  });

  // Month nav
  document.getElementById('btn-month-prev').addEventListener('click', () => {
    reportMonthOffset--;
    renderReportMonthly();
  });
  document.getElementById('btn-month-next').addEventListener('click', () => {
    reportMonthOffset++;
    renderReportMonthly();
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

  // Init Auth UI
  initAuthUI();
  initNotifBell();

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
  '#7c6af7', '#22d3ee', '#f59e0b', '#ef4444',
  '#ec4899', '#f97316', '#06b6d4', '#0ea5e9',
  '#e11d48', '#d946ef',
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
  // No-op: planner data is loaded by the unified loadData() / initFirebase() sync flow
  // plannerState is already populated via _applyState() — do not read from local store directly
}

async function savePlannerData() {
  // Delegate to the unified saveData() which handles cloud vs local correctly
  await saveData();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isVersionLocked(version) {
  if (!version.dueDate || version.pending) return false;
  const due = new Date(version.dueDate + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due < today; // locked only if PAST due, not on the due date itself
}

function getDueBadge(version) {
  if (version.pending || !version.dueDate) {
    return `<span class="version-due-badge pending">⏳ Pending</span>`;
  }

  // Use local date arithmetic — never parse without T00:00:00 to avoid UTC offset issues
  const due = new Date(version.dueDate + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0); due.setHours(0, 0, 0, 0);
  const diff = Math.round((due - today) / 86400000); // exact local days

  const tasks = plannerState.plannerTasks.filter(t => t.versionId === version.id);
  const allDone = tasks.length > 0 && tasks.every(t => t.done);

  if (diff < 0) {
    // Past due — locked. Show Released or Failed
    if (allDone) return `<span class="version-due-badge released">🚀 Released</span>`;
    return `<span class="version-due-badge failed">💥 Failed to Release</span>`;
  }
  if (diff === 0) return `<span class="version-due-badge today">🔥 Due Today · ${formatShortDate(version.dueDate)}</span>`;
  if (diff === 1) return `<span class="version-due-badge soon">⚡ 1d left · ${formatShortDate(version.dueDate)}</span>`;
  if (diff <= 7) return `<span class="version-due-badge soon">⚠ ${diff}d left · ${formatShortDate(version.dueDate)}</span>`;
  return `<span class="version-due-badge ok">📅 ${formatShortDate(version.dueDate)}</span>`;
}

function formatShortDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
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
  document.getElementById('planner-page-subtitle').textContent = 'Project board';
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

  const versions = plannerState.versions
    .filter(v => v.projectId === projectId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (versions.length === 0) {
    board.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:80px 20px;color:var(--text-muted);text-align:center;min-width:100%">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><rect x="6" y="8" width="36" height="32" rx="4" stroke="#ffffff20" stroke-width="2"/><rect x="12" y="14" width="10" height="20" rx="2" stroke="#ffffff15" stroke-width="1.5"/><rect x="26" y="18" width="10" height="16" rx="2" stroke="#ffffff15" stroke-width="1.5"/></svg>
      <div style="font-size:14px;font-weight:600;color:var(--text-secondary)">No versions yet</div>
      <div style="font-size:12px">Add a version to start planning tasks.</div>
    </div>`;
  } else {
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const locked = isVersionLocked(ver);
      const proj = plannerState.projects.find(p => p.id === projectId);
      const verColor = proj?.color || PLANNER_COLORS[0];

      const col = document.createElement('div');
      const allDone = tasks.length > 0 && tasks.every(t => t.done);
      col.className = `planner-version-col${locked ? ' locked' : ''}${allDone ? ' all-done' : ''}`;
      col.style.setProperty('--ver-color', verColor);
      col.dataset.verId = ver.id;

      const lockIcon = locked ? `<span class="version-locked-badge">🔒 Locked</span>` : '';
      const allDoneBadge = allDone ? `<span class="all-done-badge">✅ All Done</span>` : '';

      col.innerHTML = `
        <div class="version-col-header">
          <div class="version-drag-handle" title="Drag to reorder" draggable="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="4" cy="2.5" r="1" fill="currentColor"/>
              <circle cx="8" cy="2.5" r="1" fill="currentColor"/>
              <circle cx="4" cy="6" r="1" fill="currentColor"/>
              <circle cx="8" cy="6" r="1" fill="currentColor"/>
              <circle cx="4" cy="9.5" r="1" fill="currentColor"/>
              <circle cx="8" cy="9.5" r="1" fill="currentColor"/>
            </svg>
          </div>
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
            ${allDoneBadge}
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
          item.dataset.taskId = task.id;
          if (!locked) item.draggable = true;

          item.innerHTML = `
          <div class="planner-task-item-actions">
            ${!locked ? `
            <div class="drag-handle" title="Drag to reorder">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <circle cx="3" cy="2.5" r="1" fill="currentColor"/>
                <circle cx="7" cy="2.5" r="1" fill="currentColor"/>
                <circle cx="3" cy="5" r="1" fill="currentColor"/>
                <circle cx="7" cy="5" r="1" fill="currentColor"/>
                <circle cx="3" cy="7.5" r="1" fill="currentColor"/>
                <circle cx="7" cy="7.5" r="1" fill="currentColor"/>
              </svg>
            </div>
            <button class="task-mini-btn" title="Edit" data-action="edit-task" data-task-id="${task.id}">
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
            renderBoard();
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
        initTaskDrag(taskList, ver.id, locked);
      }
      initColumnDrop(taskList, ver.id, locked);

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

  // Enable header-only drag to reorder versions
  initVersionDrag(board);
}

// ── Version Column Drag-to-Reorder ───────────────────────────────────────────
function initVersionDrag(board) {
  let _verDragSrc = null;

  board.querySelectorAll('.planner-version-col').forEach(col => {
    const handle = col.querySelector('.version-drag-handle');
    if (!handle) return;

    // The handle itself is draggable=true (set in HTML).
    // Drag events on the handle bubble up — we listen on the handle for dragstart
    // so it never conflicts with task-item drags elsewhere in the column.
    handle.addEventListener('dragstart', (e) => {
      _verDragSrc = col;
      col.classList.add('ver-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-ver-id', col.dataset.verId || '');
      e.stopPropagation();
    });

    handle.addEventListener('dragend', () => {
      col.classList.remove('ver-dragging');
      board.querySelectorAll('.planner-version-col').forEach(c => c.classList.remove('ver-drag-over'));
      _verDragSrc = null;
    });

    // Drop targets: every other version column
    col.addEventListener('dragover', (e) => {
      if (!_verDragSrc || col === _verDragSrc) return;
      if (!e.dataTransfer.types.includes('text/x-ver-id')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      board.querySelectorAll('.planner-version-col').forEach(c => c.classList.remove('ver-drag-over'));
      col.classList.add('ver-drag-over');
    });

    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('ver-drag-over');
    });

    col.addEventListener('drop', (e) => {
      if (!e.dataTransfer.types.includes('text/x-ver-id')) return;
      e.preventDefault();
      e.stopPropagation();
      col.classList.remove('ver-drag-over');
      if (!_verDragSrc || col === _verDragSrc) return;

      const cols = [...board.querySelectorAll('.planner-version-col:not(.planner-add-version-col)')];
      const srcIdx = cols.indexOf(_verDragSrc);
      const tgtIdx = cols.indexOf(col);
      if (srcIdx === -1 || tgtIdx === -1) return;

      if (srcIdx < tgtIdx) board.insertBefore(_verDragSrc, col.nextSibling);
      else board.insertBefore(_verDragSrc, col);

      const newCols = [...board.querySelectorAll('.planner-version-col:not(.planner-add-version-col)')];
      newCols.forEach((c, idx) => {
        const ver = plannerState.versions.find(v => v.id === c.dataset.verId);
        if (ver) ver.order = idx;
      });

      savePlannerData();
    });
  });
}

// ── Drag & Drop ─────────────────────────────────────────────────────────────
// Board-level drag state shared across all version columns
const _boardDrag = { srcTaskId: null, srcVersionId: null };

function initTaskDrag(taskList, versionId, locked) {
  if (locked) return;

  taskList.querySelectorAll('.planner-task-item[draggable="true"]').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      _boardDrag.srcTaskId = item.dataset.taskId;
      _boardDrag.srcVersionId = versionId;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.taskId);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      // Clean up all drag-over highlights across the entire board
      document.querySelectorAll('.planner-task-item.drag-over, .version-tasks-list.drag-over-col').forEach(el => {
        el.classList.remove('drag-over', 'drag-over-col');
      });
      _boardDrag.srcTaskId = null;
      _boardDrag.srcVersionId = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const srcId = _boardDrag.srcTaskId;
      if (!srcId || item.dataset.taskId === srcId) return;
      // Clear other highlights in the same list only
      taskList.querySelectorAll('.planner-task-item').forEach(i => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation(); // prevent column drop handler from also firing
      const srcTaskId = _boardDrag.srcTaskId;
      if (!srcTaskId || item.dataset.taskId === srcTaskId) return;

      const task = plannerState.plannerTasks.find(t => t.id === srcTaskId);
      if (!task) return;

      const isCrossVersion = task.versionId !== versionId;

      if (isCrossVersion) {
        // Move task to this version
        task.versionId = versionId;
        // Place it before the hovered item in order
        const targetTask = plannerState.plannerTasks.find(t => t.id === item.dataset.taskId);
        const targetOrder = targetTask?.order ?? 0;
        // Shift existing tasks in target version down to make room
        plannerState.plannerTasks
          .filter(t => t.versionId === versionId && t.id !== srcTaskId && (t.order ?? 0) >= targetOrder)
          .forEach(t => t.order = (t.order ?? 0) + 1);
        task.order = targetOrder;
      } else {
        // Same-version reorder via DOM
        const items = [...taskList.querySelectorAll('.planner-task-item[draggable="true"]')];
        const srcEl = items.find(el => el.dataset.taskId === srcTaskId);
        if (!srcEl) return;
        const srcIdx = items.indexOf(srcEl);
        const tgtIdx = items.indexOf(item);
        if (srcIdx < tgtIdx) taskList.insertBefore(srcEl, item.nextSibling);
        else taskList.insertBefore(srcEl, item);
        // Persist new order
        [...taskList.querySelectorAll('.planner-task-item[draggable="true"]')].forEach((el, idx) => {
          const t = plannerState.plannerTasks.find(t => t.id === el.dataset.taskId);
          if (t) t.order = idx;
        });
      }

      item.classList.remove('drag-over');
      savePlannerData();
      if (isCrossVersion) renderBoard(); // re-render so task appears in new column
    });
  });
}

// Wire up a version column's task list as a cross-version drop target
function initColumnDrop(taskList, versionId, locked) {
  if (locked) {
    // Locked column: block any drop visually
    taskList.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    });
    return;
  }

  taskList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (_boardDrag.srcVersionId && _boardDrag.srcVersionId !== versionId) {
      taskList.classList.add('drag-over-col');
    }
  });

  taskList.addEventListener('dragleave', (e) => {
    // Only remove highlight when leaving the list itself (not entering a child)
    if (!taskList.contains(e.relatedTarget)) {
      taskList.classList.remove('drag-over-col');
    }
  });

  taskList.addEventListener('drop', (e) => {
    e.preventDefault();
    taskList.classList.remove('drag-over-col');

    const srcTaskId = _boardDrag.srcTaskId;
    if (!srcTaskId) return;
    const task = plannerState.plannerTasks.find(t => t.id === srcTaskId);
    if (!task || task.versionId === versionId) return; // same-version handled by item drop

    // Move task to this version, append at the end
    task.versionId = versionId;
    const maxOrder = plannerState.plannerTasks
      .filter(t => t.versionId === versionId && t.id !== srcTaskId)
      .reduce((max, t) => Math.max(max, t.order ?? 0), -1);
    task.order = maxOrder + 1;

    savePlannerData();
    renderBoard();
  });
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
      done: false,
      order: plannerState.plannerTasks.filter(t => t.versionId === plannerState.editingVersionTaskTarget).length,
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
  const versions = plannerState.versions
    .filter(v => v.projectId === projId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const dateStr = todayStr();
  const safeName = proj.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();

  // Helper: get version status label for PDF/txt
  const getVerStatus = (ver) => {
    const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id);
    const allDone = tasks.length > 0 && tasks.every(t => t.done);
    if (ver.pending || !ver.dueDate) return { label: 'Pending', released: false, failed: false, locked: false };
    const due = new Date(ver.dueDate + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0); due.setHours(0, 0, 0, 0);
    const diff = Math.round((due - today) / 86400000);
    if (diff < 0) {
      return allDone
        ? { label: 'Released', released: true, failed: false, locked: true }
        : { label: 'Failed to Release', released: false, failed: true, locked: true };
    }
    if (diff === 0) return { label: 'Due Today', released: false, failed: false, locked: false };
    return { label: diff === 1 ? '1d left' : diff + 'd left', released: false, failed: false, locked: false };
  };

  if (format === 'txt') {
    let txt = `PROJECT REPORT: ${proj.name}\n`;
    txt += `${'='.repeat(50)}\n`;
    if (proj.desc) txt += `Description: ${proj.desc}\n`;
    txt += `Generated: ${new Date().toLocaleString()}\n`;
    txt += `Versions: ${versions.length}\n\n`;
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const done = tasks.filter(t => t.done).length;
      const st = getVerStatus(ver);
      txt += `VERSION: ${ver.name}\n${'-'.repeat(40)}\n`;
      if (ver.desc) txt += `  Description: ${ver.desc}\n`;
      txt += `  Due: ${ver.pending ? 'Pending' : (ver.dueDate || 'N/A')}\n`;
      txt += `  Status: ${st.label}\n`;
      txt += `  Tasks: ${tasks.length} total, ${done} done, ${tasks.length - done} remaining\n\n`;
      tasks.forEach((t, i) => {
        txt += `  ${i + 1}. [${t.done ? 'x' : ' '}] ${t.name}`;
        txt += ` (${t.priority || 'medium'} priority)\n`;
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
    const margin = 18;
    let y = margin;
    const checkPage = (needed = 10) => {
      if (y + needed > pageH - margin) {
        doc.addPage();
        // Re-paint background tint on new page
        doc.setFillColor(tintR, tintG, tintB);
        doc.rect(0, 0, pageW, pageH, 'F');
        y = margin;
      }
    };
    const projColor = proj.color || '#7c6af7';
    const rgb = hexToRgb(projColor);
    const green = { r: 16, g: 185, b: 129 };

    // Draw a checkmark using lines (avoids unicode rendering issues in jsPDF)
    const drawCheck = (cx, cy, color) => {
      doc.setDrawColor(color.r, color.g, color.b);
      doc.setLineWidth(0.55);
      doc.line(cx - 0.9, cy + 0.1, cx - 0.1, cy + 1.0);
      doc.line(cx - 0.1, cy + 1.0, cx + 1.3, cy - 0.8);
      doc.setLineWidth(0.2);
    };

    // ── Page background tint (subtle project-color wash) ─────────────────────
    doc.setFillColor(rgb.r, rgb.g, rgb.b, 0.06); // very faint tint
    // jsPDF doesn't support alpha natively, so blend manually toward white
    const tintR = Math.round(rgb.r * 0.06 + 255 * 0.94);
    const tintG = Math.round(rgb.g * 0.06 + 255 * 0.94);
    const tintB = Math.round(rgb.b * 0.06 + 255 * 0.94);
    doc.setFillColor(tintR, tintG, tintB);
    doc.rect(0, 0, pageW, pageH, 'F');

    // ── Title strip (full project color) ─────────────────────────────────────
    const titleStripH = 28;
    doc.setFillColor(rgb.r, rgb.g, rgb.b);
    doc.rect(0, 0, pageW, titleStripH, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(17); doc.setFont('helvetica', 'bold');
    doc.text(proj.name, margin, 14);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal');
    doc.text('Project Report', margin, 22);
    doc.text(new Date().toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }), pageW - margin, 22, { align: 'right' });

    // ── Description strip (darkened band — 40% darker than project color) ────
    const descMaxW = pageW - margin * 2;
    let descLines = [];
    if (proj.desc) {
      doc.setFontSize(8.5); doc.setFont('helvetica', 'italic');
      descLines = doc.splitTextToSize(proj.desc, descMaxW);
    }
    const descLineH = 5;
    const descPadV = proj.desc ? 8 + descLines.length * descLineH : 0;

    if (proj.desc) {
      // Darken the project color by blending toward black (40%)
      const dR = Math.round(rgb.r * 0.60);
      const dG = Math.round(rgb.g * 0.60);
      const dB = Math.round(rgb.b * 0.60);
      doc.setFillColor(dR, dG, dB);
      doc.rect(0, titleStripH, pageW, descPadV, 'F');

      // Thin separator line between title and description band
      doc.setDrawColor(255, 255, 255, 0.2);
      doc.setLineWidth(0.3);
      doc.line(0, titleStripH, pageW, titleStripH);
      doc.setLineWidth(0.2);

      // Description text — soft white
      doc.setTextColor(230, 230, 255);
      doc.setFontSize(8.5); doc.setFont('helvetica', 'italic');
      descLines.forEach((line, i) => {
        doc.text(line, margin, titleStripH + 6 + i * descLineH);
      });
    }

    y = titleStripH + descPadV + 8;

    // ── Summary box ───────────────────────────────────────────────────────────
    const totalTasks = plannerState.plannerTasks.filter(t => versions.some(v => v.id === t.versionId)).length;
    const doneTasks = plannerState.plannerTasks.filter(t => versions.some(v => v.id === t.versionId) && t.done).length;
    const allProjDone = totalTasks > 0 && doneTasks === totalTasks;
    if (allProjDone) {
      doc.setFillColor(220, 248, 236);
    } else {
      const sbR = Math.round(rgb.r * 0.35 + 255 * 0.65);
      const sbG = Math.round(rgb.g * 0.35 + 255 * 0.65);
      const sbB = Math.round(rgb.b * 0.35 + 255 * 0.65);
      doc.setFillColor(sbR, sbG, sbB);
    }
    doc.roundedRect(margin, y, pageW - margin * 2, 8, 2, 2, 'F');
    doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(allProjDone ? [green.r, green.g, green.b] : [60, 60, 60]));
    doc.text('Versions: ' + versions.length, margin + 5, y + 5, { align: 'left' });
    doc.text('Total Tasks: ' + totalTasks, pageW / 2, y + 5, { align: 'center' });
    const completedLabel = allProjDone ? 'All Finished (' + doneTasks + '/' + totalTasks + ')' : 'Completed: ' + doneTasks + ' / ' + totalTasks;
    doc.text(completedLabel, pageW - margin - 5, y + 5, { align: 'right' });
    if (allProjDone) {
      const tw = doc.getTextWidth(completedLabel);
      drawCheck(pageW - margin - 5 - tw - 3, y + 7, green);
    }
    y += 18;

    // Versions
    versions.forEach(ver => {
      const tasks = plannerState.plannerTasks.filter(t => t.versionId === ver.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const done = tasks.filter(t => t.done).length;
      const allDone = tasks.length > 0 && done === tasks.length;
      const st = getVerStatus(ver);

      // Header bar color: green=released, red=failed, project color=everything else
      const released = { r: 16, g: 185, b: 129 };  // green
      const failed = { r: 220, g: 50, b: 50 };  // red
      const verRgb = st.released ? released : st.failed ? failed : (allDone ? green : rgb);
      const rowH = 5.5;

      checkPage(22);

      // Build right-side badge: Released 🚀 / Failed 💥 / FINISHED / Due: ...
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      let rightLabel;
      if (st.released) rightLabel = '>> RELEASED <<';
      else if (st.failed) rightLabel = 'FAILED TO RELEASE';
      else if (allDone) rightLabel = 'FINISHED';
      else rightLabel = 'Due: ' + (ver.pending ? 'Pending' : (ver.dueDate || 'N/A')) + '   ' + done + '/' + tasks.length + ' done';

      const rightLabelW = doc.getTextWidth(rightLabel);
      const rightX = pageW - margin - 3.5;

      // Version header bar
      doc.setFillColor(verRgb.r, verRgb.g, verRgb.b);
      doc.roundedRect(margin, y, pageW - margin * 2, 8, 2, 2, 'F');
      doc.setTextColor(255, 255, 255);

      // Icon before the right label
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      if (allDone && !st.released) {
        drawCheck(rightX - rightLabelW - 3, y + 3.9, { r: 255, g: 255, b: 255 });
      }
      doc.setFontSize(9); doc.setFont('helvetica', 'bold');
      doc.text(rightLabel, rightX, y + 5, { align: 'right' });

      // Also show 🔒 Locked badge text next to version name if locked but not released/failed
      const lockedSuffix = (st.locked && !st.released && !st.failed) ? '  [LOCKED]' : '';

      // Version name truncated to not overlap right badge
      const maxNameW = pageW - margin * 2 - rightLabelW - ((allDone || st.released || st.failed) ? 12 : 8);
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      const verNameStr = doc.splitTextToSize(ver.name + lockedSuffix, maxNameW)[0];
      doc.text(verNameStr, margin + 4, y + 5);

      y += 14;

      // Tasks
      if (tasks.length === 0) {
        doc.setTextColor(180, 180, 180); doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
        doc.text('No tasks', margin + 4, y + 3.5); y += 7;
      } else {
        tasks.forEach((task, i) => {
          checkPage(rowH + 2);
          // Alternating row bg
          if (i % 2 === 0) {
            if (allDone) {
              doc.setFillColor(238, 251, 245);
            } else {
              const rowR = Math.round(rgb.r * 0.05 + 255 * 0.95);
              const rowG = Math.round(rgb.g * 0.05 + 255 * 0.95);
              const rowB = Math.round(rgb.b * 0.05 + 255 * 0.95);
              doc.setFillColor(rowR, rowG, rowB);
            }
            doc.rect(margin, y, pageW - margin * 2, rowH, 'F');
          }
          // Checkbox — 3.5x3.5, vertically centered in rowH
          const cbSize = 3.5;
          const cbX = margin + 3;
          const cbY = y + (rowH - cbSize) / 2;
          const cbCx = cbX + cbSize / 2;
          const cbCy = cbY + cbSize / 2;
          if (task.done) {
            doc.setFillColor(verRgb.r, verRgb.g, verRgb.b);
            doc.setDrawColor(verRgb.r, verRgb.g, verRgb.b);
            doc.setLineWidth(0.2);
            doc.roundedRect(cbX, cbY, cbSize, cbSize, 0.6, 0.6, 'FD');
            // Tick: short left leg down, long right leg up — centered on cbCx, cbCy
            doc.setDrawColor(255, 255, 255);
            doc.setLineWidth(0.5);
            doc.line(cbCx - 0.7, cbCy, cbCx - 0.1, cbCy + 0.7);
            doc.line(cbCx - 0.1, cbCy + 0.7, cbCx + 0.9, cbCy - 0.6);
            doc.setLineWidth(0.2);
          } else {
            doc.setDrawColor(190, 190, 190);
            doc.setLineWidth(0.3);
            doc.roundedRect(cbX, cbY, cbSize, cbSize, 0.6, 0.6, 'S');
            doc.setLineWidth(0.2);
          }
          // Task name — vertically centered
          const textY = y + rowH / 2 + 1.0;
          doc.setTextColor(...(task.done ? [150, 150, 150] : [25, 25, 25]));
          doc.setFontSize(7.5); doc.setFont('helvetica', task.done ? 'normal' : 'bold');
          const maxNW = pageW - margin * 2 - 30;
          const tName = doc.splitTextToSize(task.name, maxNW)[0];
          doc.text(tName, margin + 9, textY);
          // Priority — vertically centered
          const pColors = { high: [220, 50, 50], medium: [190, 130, 10], low: [16, 160, 100] };
          doc.setTextColor(...pColors[task.priority || 'medium']);
          doc.setFontSize(5.5); doc.setFont('helvetica', 'bold');
          doc.text((task.priority || 'medium').toUpperCase(), pageW - margin - 3, textY, { align: 'right' });
          y += rowH;
        });
      }
      y += 5;
    });

    // Footer
    checkPage(12);
    doc.setDrawColor(220, 220, 220); doc.line(margin, y, pageW - margin, y); y += 6;
    doc.setFontSize(7.5); doc.setTextColor(170, 170, 170); doc.setFont('helvetica', 'normal');
    doc.text('Generated by WorkTracker', margin, y);
    doc.text(new Date().toLocaleString(), pageW - margin, y, { align: 'right' });

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