// ── WorkTracker: Organizations Module (Phase 1) ──────────────────────────────
// Loaded after app.js — shares its global scope (fbAuth, fbDb, currentUser,
// firebase, showNotif, showConfirm, switchPage, etc.)
//
// Collections used (see docs/ORGANIZATIONS_AND_ROLES.md):
//   userProfiles/{uid}                         public lookup doc (NOT the
//                                               existing private `users/{uid}`
//                                               doc, which already holds each
//                                               person's full private data)
//   organizations/{orgId}
//   organizations/{orgId}/members/{uid}
//   organizations/{orgId}/activity/{activityId}

const ORG_COLORS = (typeof PLANNER_COLORS !== 'undefined' && PLANNER_COLORS.length)
  ? PLANNER_COLORS
  : ['#7c6af7', '#22d3ee', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#a78bfa', '#f97316'];

const ROLE_LABELS = { admin: 'Admin', planner: 'Planner', developer: 'Developer', visitor: 'Visitor' };
const ROLE_ORDER = ['visitor', 'developer', 'planner', 'admin']; // low → high, used for sorting + dropdowns

const orgState = {
  myOrgs: [],              // [{ orgId, orgName, orgColor, role }] — live, from collectionGroup('members')
  currentOrgId: null,
  currentOrgMembers: [],    // live members of the currently-open org
  currentOrgActivity: [],   // live activity feed of the currently-open org
  memberSearch: '',
  selectedCreateColor: ORG_COLORS[0],
  _lookupResult: null,      // pending profile from the Add Member lookup
  _unsubMyOrgs: null,
  _unsubMembers: null,
  _unsubActivity: null,
};

// ── Small helpers ─────────────────────────────────────────────────────────────

function _orgEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function _roleBadgeHTML(role) {
  const cls = { admin: 'org-role-admin', planner: 'org-role-planner', developer: 'org-role-developer', visitor: 'org-role-visitor' }[role] || 'org-role-visitor';
  return `<span class="org-role-badge ${cls}">${ROLE_LABELS[role] || role}</span>`;
}

function _avatarHTML(photoURL, displayName, size) {
  size = size || 32;
  if (photoURL) {
    return `<img src="${photoURL}" class="org-avatar" style="width:${size}px;height:${size}px" alt="" />`;
  }
  const initial = (displayName || '?').trim().charAt(0).toUpperCase() || '?';
  return `<div class="org-avatar org-avatar-fallback" style="width:${size}px;height:${size}px">${_orgEsc(initial)}</div>`;
}

function _fmtWhen(ts) {
  try {
    const d = ts && ts.toDate ? ts.toDate() : new Date();
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ── User Profile (public lookup doc, separate from the private `users/{uid}`) ─

async function ensureUserProfile(user) {
  if (!user || !fbDb) return;
  try {
    await fbDb.collection('userProfiles').doc(user.uid).set({
      email: (user.email || '').trim().toLowerCase(),
      displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
      photoURL: user.photoURL || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) { console.warn('Could not write user profile:', e); }
}

async function lookupUserProfileByEmail(email) {
  const clean = (email || '').trim().toLowerCase();
  if (!clean || !fbDb) return null;
  try {
    const snap = await fbDb.collection('userProfiles').where('email', '==', clean).limit(1).get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { uid: doc.id, ...doc.data() };
  } catch (e) {
    console.warn('User lookup failed:', e);
    return null;
  }
}

// ── Activity logging (append-only) ───────────────────────────────────────────

async function _logOrgActivity(orgId, type, targetSummary) {
  if (!fbDb || !currentUser) return;
  try {
    await fbDb.collection('organizations').doc(orgId).collection('activity').add({
      type,
      targetSummary: targetSummary || '',
      actorUid: currentUser.uid,
      actorDisplayName: currentUser.displayName || currentUser.email || 'Someone',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('Could not log activity:', e); }
}

const ORG_ACTIVITY_LABELS = {
  org_created: () => `created the organization`,
  member_added: a => `added ${a.targetSummary || 'a member'}`,
  member_removed: a => `removed ${a.targetSummary || 'a member'}`,
  member_left: () => `left the organization`,
  role_changed: a => `changed ${a.targetSummary || "a member's"} role`,
};

// ── Create Organization ──────────────────────────────────────────────────────

async function createOrganization(name, color) {
  if (!currentUser) { showNotif('Sign in to create an organization', 'error'); return; }
  const clean = (name || '').trim();
  if (!clean) { showNotif('Enter an organization name', 'error'); return; }
  const finalColor = color || ORG_COLORS[0];
  try {
    const orgRef = fbDb.collection('organizations').doc();
    const batch = fbDb.batch();
    batch.set(orgRef, {
      name: clean,
      color: finalColor,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      adminCount: 1,
    });
    batch.set(orgRef.collection('members').doc(currentUser.uid), {
      role: 'admin',
      uid: currentUser.uid,
      email: (currentUser.email || '').trim().toLowerCase(),
      displayName: currentUser.displayName || currentUser.email || 'You',
      photoURL: currentUser.photoURL || '',
      orgId: orgRef.id,
      orgName: clean,
      orgColor: finalColor,
      addedBy: currentUser.uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    await _logOrgActivity(orgRef.id, 'org_created', clean);
    showNotif(`Organization "${clean}" created 🎉`, 'success');
    closeOrgCreateModal();
  } catch (e) {
    console.warn(e);
    showNotif('Could not create organization', 'error');
  }
}

// ── Add / Remove / Role-change members ───────────────────────────────────────

async function addOrgMember(orgId, profile, role) {
  role = role || 'visitor';
  const org = orgState.myOrgs.find(o => o.orgId === orgId) || {};
  try {
    await fbDb.collection('organizations').doc(orgId).collection('members').doc(profile.uid).set({
      role,
      uid: profile.uid,
      email: profile.email || '',
      displayName: profile.displayName || profile.email || 'User',
      photoURL: profile.photoURL || '',
      orgId,
      orgName: org.orgName || '',
      orgColor: org.orgColor || ORG_COLORS[0],
      addedBy: currentUser.uid,
      addedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await _logOrgActivity(orgId, 'member_added', profile.displayName || profile.email);
    showNotif(`${profile.displayName || profile.email} added as Visitor`, 'success');
    closeOrgAddMemberModal();
  } catch (e) {
    console.warn(e);
    showNotif('Could not add member', 'error');
  }
}

async function changeMemberRole(orgId, uid, newRole) {
  const orgRef = fbDb.collection('organizations').doc(orgId);
  const memberRef = orgRef.collection('members').doc(uid);
  let targetName = '';
  try {
    await fbDb.runTransaction(async tx => {
      const orgSnap = await tx.get(orgRef);
      const memberSnap = await tx.get(memberRef);
      if (!orgSnap.exists || !memberSnap.exists) throw new Error('NOT_FOUND');
      const org = orgSnap.data();
      const member = memberSnap.data();
      targetName = member.displayName || member.email || '';
      const wasAdmin = member.role === 'admin';
      const willBeAdmin = newRole === 'admin';
      let adminCount = org.adminCount || 0;
      if (wasAdmin && !willBeAdmin) {
        if (adminCount <= 1) throw new Error('SOLE_ADMIN');
        adminCount -= 1;
        tx.update(orgRef, { adminCount });
      } else if (!wasAdmin && willBeAdmin) {
        adminCount += 1;
        tx.update(orgRef, { adminCount });
      }
      tx.update(memberRef, { role: newRole });
    });
    await _logOrgActivity(orgId, 'role_changed', `${targetName} → ${ROLE_LABELS[newRole]}`);
    showNotif('Role updated', 'success');
  } catch (e) {
    if (e.message === 'SOLE_ADMIN') {
      showNotif('Cannot change this — they are the only Admin. Promote someone else first.', 'error');
      renderOrgMemberList(); // revert any optimistic UI (select value) back to the live state
    } else {
      console.warn(e);
      showNotif('Could not update role', 'error');
    }
  }
}

async function removeOrgMember(orgId, uid, opts) {
  opts = opts || {};
  const orgRef = fbDb.collection('organizations').doc(orgId);
  const memberRef = orgRef.collection('members').doc(uid);
  let targetName = '';
  try {
    await fbDb.runTransaction(async tx => {
      const orgSnap = await tx.get(orgRef);
      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) return;
      const org = orgSnap.data() || {};
      const member = memberSnap.data();
      targetName = member.displayName || member.email || '';
      if (member.role === 'admin') {
        const adminCount = org.adminCount || 0;
        if (adminCount <= 1) throw new Error('SOLE_ADMIN');
        tx.update(orgRef, { adminCount: adminCount - 1 });
      }
      tx.delete(memberRef);
    });
    await _logOrgActivity(orgId, opts.isSelfLeave ? 'member_left' : 'member_removed', targetName);
    showNotif(opts.isSelfLeave ? 'You left the organization' : 'Member removed', 'success');
    if (opts.isSelfLeave && orgState.currentOrgId === orgId) backToOrgList();
  } catch (e) {
    if (e.message === 'SOLE_ADMIN') {
      showNotif(
        opts.isSelfLeave
          ? 'You are the only Admin — promote someone else before leaving'
          : 'Cannot remove the only Admin',
        'error'
      );
    } else {
      console.warn(e);
      showNotif('Could not complete action', 'error');
    }
  }
}

function confirmRemoveOrgMember(orgId, uid, name) {
  showConfirm('Remove Member', `Remove ${name} from this organization?`, () => removeOrgMember(orgId, uid, {}));
}

function confirmLeaveOrg(orgId) {
  showConfirm(
    'Leave Organization',
    `Leave this organization? You'll lose access to its shared plans.`,
    () => removeOrgMember(orgId, currentUser.uid, { isSelfLeave: true })
  );
}

// ── Live listeners ────────────────────────────────────────────────────────────

function startMyOrgsListener() {
  if (orgState._unsubMyOrgs) { orgState._unsubMyOrgs(); orgState._unsubMyOrgs = null; }
  if (!currentUser || !fbDb) { orgState.myOrgs = []; renderOrgList(); return; }
  orgState._unsubMyOrgs = fbDb.collectionGroup('members')
    .where('uid', '==', currentUser.uid)
    .onSnapshot(snap => {
      orgState.myOrgs = snap.docs.map(d => {
        const m = d.data();
        return { orgId: m.orgId, orgName: m.orgName, orgColor: m.orgColor, role: m.role };
      });
      renderOrgList();
      if (orgState.currentOrgId) {
        const mine = orgState.myOrgs.find(o => o.orgId === orgState.currentOrgId);
        if (mine) renderOrgDetailHeader(mine);
        else backToOrgList(); // we were removed/left while viewing it
        renderOrgMemberList(); // role dropdowns/buttons depend on "my role"
      }
    }, err => console.warn('My orgs listener error:', err));
}

function startOrgMembersListener(orgId) {
  if (orgState._unsubMembers) { orgState._unsubMembers(); orgState._unsubMembers = null; }
  orgState._unsubMembers = fbDb.collection('organizations').doc(orgId).collection('members')
    .onSnapshot(snap => {
      orgState.currentOrgMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderOrgMemberList();
    }, err => console.warn('Members listener error:', err));
}

function startOrgActivityListener(orgId) {
  if (orgState._unsubActivity) { orgState._unsubActivity(); orgState._unsubActivity = null; }
  orgState._unsubActivity = fbDb.collection('organizations').doc(orgId).collection('activity')
    .orderBy('createdAt', 'desc').limit(50)
    .onSnapshot(snap => {
      orgState.currentOrgActivity = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderOrgActivityList();
    }, err => console.warn('Activity listener error:', err));
}

function stopOrgDetailListeners() {
  if (orgState._unsubMembers) { orgState._unsubMembers(); orgState._unsubMembers = null; }
  if (orgState._unsubActivity) { orgState._unsubActivity(); orgState._unsubActivity = null; }
}

// ── Rendering: org list ──────────────────────────────────────────────────────

function renderOrgList() {
  const grid = document.getElementById('org-list-grid');
  if (!grid) return;
  if (!currentUser) {
    grid.innerHTML = `<div class="planner-empty" style="grid-column:1/-1">
      <h3>Sign in required</h3>
      <p>Sign in to create or join organizations.</p>
    </div>`;
    return;
  }
  if (!orgState.myOrgs.length) {
    grid.innerHTML = `<div class="planner-empty" style="grid-column:1/-1">
      <h3>No organizations yet</h3>
      <p>Create one to start adding employees and sharing plans.</p>
    </div>`;
    return;
  }
  grid.innerHTML = orgState.myOrgs.map(o => `
    <div class="planner-project-card" style="--proj-color:${o.orgColor}" onclick="openOrgDetail('${o.orgId}')">
      <div class="proj-card-header">
        <div class="proj-card-icon">🏢</div>
      </div>
      <div class="proj-card-name">${_orgEsc(o.orgName)}</div>
      <div class="proj-card-meta">${_roleBadgeHTML(o.role)}</div>
    </div>
  `).join('');
}

// ── Rendering: org detail (members + activity) ──────────────────────────────

function renderOrgDetailHeader(mine) {
  const title = document.getElementById('org-page-title');
  const sub = document.getElementById('org-page-subtitle');
  if (title) title.textContent = mine ? mine.orgName : 'Organization';
  if (sub) sub.innerHTML = mine ? `Your role: ${_roleBadgeHTML(mine.role)}` : '';
}

function renderOrgMemberList() {
  const list = document.getElementById('org-member-list');
  if (!list || !orgState.currentOrgId) return;

  const mine = orgState.myOrgs.find(o => o.orgId === orgState.currentOrgId);
  const isAdmin = mine && mine.role === 'admin';

  const addBtn = document.getElementById('btn-org-add-member');
  if (addBtn) addBtn.style.display = isAdmin ? 'inline-flex' : 'none';

  const q = orgState.memberSearch.trim().toLowerCase();
  let members = orgState.currentOrgMembers.slice()
    .sort((a, b) => ROLE_ORDER.indexOf(b.role) - ROLE_ORDER.indexOf(a.role));
  if (q) {
    members = members.filter(m =>
      (m.displayName || '').toLowerCase().includes(q) ||
      (m.email || '').toLowerCase().includes(q)
    );
  }

  if (!members.length) {
    list.innerHTML = `<div class="empty-state"><p>${q ? 'No members match your search.' : 'No members yet.'}</p></div>`;
    return;
  }

  list.innerHTML = members.map(m => {
    const isMe = currentUser && m.id === currentUser.uid;
    const roleCell = (isAdmin && !isMe)
      ? `<select class="setting-input org-role-select" onchange="changeMemberRole('${orgState.currentOrgId}','${m.id}', this.value)">
          ${ROLE_ORDER.map(r => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
        </select>`
      : _roleBadgeHTML(m.role);
    const actionCell = (isAdmin && !isMe)
      ? `<button class="task-btn delete" title="Remove member" onclick="confirmRemoveOrgMember('${orgState.currentOrgId}','${m.id}','${_orgEsc(m.displayName || m.email).replace(/'/g, "\\'")}')">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>`
      : (isMe
        ? `<button class="btn-secondary" style="padding:6px 12px;font-size:12px" onclick="confirmLeaveOrg('${orgState.currentOrgId}')">Leave</button>`
        : '');

    return `
      <div class="task-card">
        ${_avatarHTML(m.photoURL, m.displayName, 34)}
        <div class="task-card-info">
          <div class="task-card-name">${_orgEsc(m.displayName || m.email)}${isMe ? ' <span style="color:var(--text-muted);font-weight:400">(you)</span>' : ''}</div>
          <div class="task-card-meta"><span>${_orgEsc(m.email)}</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          ${roleCell}
          ${actionCell}
        </div>
      </div>`;
  }).join('');
}

function renderOrgActivityList() {
  const list = document.getElementById('org-activity-list');
  if (!list) return;
  if (!orgState.currentOrgActivity.length) {
    list.innerHTML = `<div class="empty-state"><p>No activity yet.</p></div>`;
    return;
  }
  list.innerHTML = orgState.currentOrgActivity.map(a => {
    const fn = ORG_ACTIVITY_LABELS[a.type];
    const text = fn ? fn(a) : a.type;
    return `
      <div class="task-card" style="padding:12px 16px">
        <div class="task-card-info">
          <div class="task-card-name" style="font-size:13px;font-weight:500">
            <b>${_orgEsc(a.actorDisplayName)}</b> ${_orgEsc(text)}
          </div>
          <div class="task-card-meta">${_fmtWhen(a.createdAt)}</div>
        </div>
      </div>`;
  }).join('');
}

// ── Navigation between list/detail ──────────────────────────────────────────

function openOrgDetail(orgId) {
  orgState.currentOrgId = orgId;
  orgState.memberSearch = '';
  const input = document.getElementById('org-member-search');
  if (input) input.value = '';
  const clearBtn = document.getElementById('org-member-search-clear');
  if (clearBtn) clearBtn.style.display = 'none';

  document.getElementById('org-list-view').style.display = 'none';
  document.getElementById('org-detail-view').style.display = 'block';
  document.getElementById('btn-org-back').style.display = 'inline-flex';
  document.getElementById('btn-org-new').style.display = 'none';

  const mine = orgState.myOrgs.find(o => o.orgId === orgId);
  renderOrgDetailHeader(mine);
  startOrgMembersListener(orgId);
  startOrgActivityListener(orgId);
}

function backToOrgList() {
  orgState.currentOrgId = null;
  stopOrgDetailListeners();
  document.getElementById('org-list-view').style.display = 'block';
  document.getElementById('org-detail-view').style.display = 'none';
  document.getElementById('btn-org-back').style.display = 'none';
  document.getElementById('btn-org-new').style.display = 'inline-flex';
  document.getElementById('org-page-title').textContent = 'Organizations';
  document.getElementById('org-page-subtitle').textContent = 'Create teams and manage shared plans';
}

// ── Create Organization modal ───────────────────────────────────────────────

function openOrgCreateModal() {
  if (!currentUser) { showNotif('Sign in to create an organization', 'error'); return; }
  document.getElementById('org-create-name').value = '';
  orgState.selectedCreateColor = ORG_COLORS[0];
  const picker = document.getElementById('org-create-color-picker');
  picker.innerHTML = ORG_COLORS.map(c =>
    `<div class="color-swatch ${c === orgState.selectedCreateColor ? 'selected' : ''}" data-color="${c}" style="background:${c}" onclick="_selectOrgCreateColor('${c}')"></div>`
  ).join('');
  document.getElementById('org-create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('org-create-name').focus(), 50);
}

function _selectOrgCreateColor(c) {
  orgState.selectedCreateColor = c;
  document.querySelectorAll('#org-create-color-picker .color-swatch').forEach(el => {
    el.classList.toggle('selected', el.getAttribute('data-color') === c);
  });
}

function closeOrgCreateModal() {
  document.getElementById('org-create-modal').style.display = 'none';
}

// ── Add Member modal ─────────────────────────────────────────────────────────

function openOrgAddMemberModal() {
  orgState._lookupResult = null;
  document.getElementById('org-addmember-email').value = '';
  document.getElementById('org-addmember-result').style.display = 'none';
  document.getElementById('org-addmember-result').innerHTML = '';
  document.getElementById('org-addmember-notfound').style.display = 'none';
  document.getElementById('org-addmember-confirm').style.display = 'none';
  document.getElementById('org-addmember-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('org-addmember-email').focus(), 50);
}

function closeOrgAddMemberModal() {
  document.getElementById('org-addmember-modal').style.display = 'none';
}

async function lookupOrgAddMember() {
  const emailInput = document.getElementById('org-addmember-email');
  const btn = document.getElementById('org-addmember-lookup');
  const resultEl = document.getElementById('org-addmember-result');
  const notFoundEl = document.getElementById('org-addmember-notfound');
  const confirmBtn = document.getElementById('org-addmember-confirm');

  resultEl.style.display = 'none';
  notFoundEl.style.display = 'none';
  confirmBtn.style.display = 'none';
  orgState._lookupResult = null;

  const email = emailInput.value.trim();
  if (!email) { showNotif('Enter a Gmail address', 'error'); return; }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Searching…';
  try {
    const profile = await lookupUserProfileByEmail(email);
    if (!profile) {
      notFoundEl.textContent = 'No account found for this email.';
      notFoundEl.style.display = 'block';
    } else if (orgState.currentOrgMembers.some(m => m.id === profile.uid)) {
      notFoundEl.textContent = 'This person is already a member.';
      notFoundEl.style.display = 'block';
    } else {
      resultEl.innerHTML = `
        <div class="task-card">
          ${_avatarHTML(profile.photoURL, profile.displayName, 40)}
          <div class="task-card-info">
            <div class="task-card-name">${_orgEsc(profile.displayName)}</div>
            <div class="task-card-meta"><span>${_orgEsc(profile.email)}</span></div>
          </div>
        </div>`;
      resultEl.style.display = 'block';
      confirmBtn.style.display = 'inline-flex';
      orgState._lookupResult = profile;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function confirmAddOrgMember() {
  if (!orgState._lookupResult || !orgState.currentOrgId) return;
  addOrgMember(orgState.currentOrgId, orgState._lookupResult, 'visitor');
}

// ── Init ──────────────────────────────────────────────────────────────────────

function _initOrgModule() {
  if (typeof fbAuth === 'undefined' || !fbAuth) { setTimeout(_initOrgModule, 200); return; }

  fbAuth.onAuthStateChanged(user => {
    if (user) {
      ensureUserProfile(user);
      startMyOrgsListener();
    } else {
      if (orgState._unsubMyOrgs) { orgState._unsubMyOrgs(); orgState._unsubMyOrgs = null; }
      stopOrgDetailListeners();
      orgState.myOrgs = [];
      orgState.currentOrgMembers = [];
      orgState.currentOrgActivity = [];
      backToOrgList();
      renderOrgList();
    }
  });

  document.getElementById('btn-org-new')?.addEventListener('click', openOrgCreateModal);
  document.getElementById('btn-org-back')?.addEventListener('click', backToOrgList);

  document.getElementById('org-create-close')?.addEventListener('click', closeOrgCreateModal);
  document.getElementById('org-create-cancel')?.addEventListener('click', closeOrgCreateModal);
  document.getElementById('org-create-save')?.addEventListener('click', () => {
    createOrganization(document.getElementById('org-create-name').value, orgState.selectedCreateColor);
  });

  document.getElementById('btn-org-add-member')?.addEventListener('click', openOrgAddMemberModal);
  document.getElementById('org-addmember-close')?.addEventListener('click', closeOrgAddMemberModal);
  document.getElementById('org-addmember-cancel')?.addEventListener('click', closeOrgAddMemberModal);
  document.getElementById('org-addmember-lookup')?.addEventListener('click', lookupOrgAddMember);
  document.getElementById('org-addmember-confirm')?.addEventListener('click', confirmAddOrgMember);
  document.getElementById('org-addmember-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupOrgAddMember(); }
  });

  const searchInput = document.getElementById('org-member-search');
  const searchClear = document.getElementById('org-member-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      orgState.memberSearch = searchInput.value;
      if (searchClear) searchClear.style.display = searchInput.value ? 'flex' : 'none';
      renderOrgMemberList();
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      orgState.memberSearch = '';
      searchClear.style.display = 'none';
      renderOrgMemberList();
    });
  }
}

_initOrgModule();
