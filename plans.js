// ── WorkTracker: Plan Sharing Module (Phase 2) ───────────────────────────────
// Loaded after app.js and org.js — shares their global scope (fbAuth, fbDb,
// currentUser, firebase, showNotif, showConfirm, plannerState, orgState,
// ROLE_LABELS, ROLE_ORDER, PLANNER_COLORS, _orgEsc, _avatarHTML,
// _roleBadgeHTML, ensureUserProfile, lookupUserProfileByEmail, etc.)
//
// Collections used (see docs/ORGANIZATIONS_AND_ROLES.md §3):
//   plans/{planId}                              name, desc, color, createdAt,
//                                                createdBy, orgId, directMembers,
//                                                status
//   organizations/{orgId}/members/{uid}         read here to power the org
//                                                picker and the "via org" rows
//                                                in the plan's member list
//   userProfiles/{uid}                          looked up for individually
//                                                added members and to resolve
//                                                display info for directMembers
//                                                entries that didn't come from
//                                                an attached org
//
// A "Plan" is a shared Planner Project — plans/{planId} uses the SAME id as
// the local plannerState.projects entry, so the two stay 1:1.
//
// Effective role resolution (also enforced in firestore.rules):
//   plan.directMembers[uid]  — overrides —  attached org's members[uid].role

const planShareState = {
  currentPlanId: null,
  currentPlan: null,          // live plans/{planId} doc data, plus id
  memberSearch: '',
  addMemberLookupResult: null,
  directProfiles: {},         // uid -> { displayName, email, photoURL } cache
                               // for directMembers entries not covered by an
                               // attached org's member list
  orgMembersCache: {},        // orgId -> [{ id, role, displayName, email, photoURL }]
  orgPicker: {
    orgId: null,
    members: [],
    selected: new Set(),
    roles: {},                // uid -> role chosen in the picker
    search: '',
  },
  _unsubPlan: null,
  _unsubOrgMembers: null,
  _orgMembersListenerOrgId: null,
};

// ── Ensure the shared plans/{planId} doc exists ──────────────────────────────

async function ensurePlanDoc(planId) {
  if (!fbDb || !currentUser) return null;
  const planRef = fbDb.collection('plans').doc(planId);
  try {
    const snap = await planRef.get();
    if (snap.exists) return { id: snap.id, ...snap.data() };

    const proj = plannerState.projects.find(p => p.id === planId) || {};
    const data = {
      name: proj.name || 'Untitled Plan',
      desc: proj.desc || '',
      color: proj.color || PLANNER_COLORS[0],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid,
      orgId: null,
      directMembers: { [currentUser.uid]: 'admin' },
      status: 'active',
    };
    await planRef.set(data);
    return { id: planId, ...data };
  } catch (e) {
    console.warn('Could not ensure plan doc:', e);
    return null;
  }
}

// ── Live listeners ────────────────────────────────────────────────────────────

function startPlanListener(planId) {
  stopPlanListener();
  planShareState._unsubPlan = fbDb.collection('plans').doc(planId)
    .onSnapshot(snap => {
      if (!snap.exists) return;
      planShareState.currentPlan = { id: snap.id, ...snap.data() };
      const orgId = planShareState.currentPlan.orgId;
      if (orgId && planShareState._orgMembersListenerOrgId !== orgId) {
        _startPlanOrgMembersListener(orgId);
      } else if (!orgId && planShareState._unsubOrgMembers) {
        planShareState._unsubOrgMembers();
        planShareState._unsubOrgMembers = null;
        planShareState._orgMembersListenerOrgId = null;
      }
      renderSharePlanModal();
    }, err => console.warn('Plan listener error:', err));
}

function _startPlanOrgMembersListener(orgId) {
  if (planShareState._unsubOrgMembers) { planShareState._unsubOrgMembers(); planShareState._unsubOrgMembers = null; }
  planShareState._orgMembersListenerOrgId = orgId;
  planShareState._unsubOrgMembers = fbDb.collection('organizations').doc(orgId).collection('members')
    .onSnapshot(snap => {
      planShareState.orgMembersCache[orgId] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderSharePlanModal();
    }, err => console.warn('Plan org members listener error:', err));
}

function stopPlanListener() {
  if (planShareState._unsubPlan) { planShareState._unsubPlan(); planShareState._unsubPlan = null; }
  if (planShareState._unsubOrgMembers) { planShareState._unsubOrgMembers(); planShareState._unsubOrgMembers = null; }
  planShareState._orgMembersListenerOrgId = null;
}

// ── Role helpers ──────────────────────────────────────────────────────────────

function computeMyPlanRole() {
  const plan = planShareState.currentPlan;
  if (!plan || !currentUser) return null;
  const direct = plan.directMembers || {};
  if (direct[currentUser.uid]) return direct[currentUser.uid];
  if (plan.orgId) {
    const mine = orgState.myOrgs.find(o => o.orgId === plan.orgId);
    if (mine) return mine.role;
  }
  return null;
}

// Combines directMembers (explicit, wins) with the attached org's members
// (default, "via org") into one de-duplicated list for rendering.
function computePlanMembers() {
  const plan = planShareState.currentPlan;
  if (!plan) return [];
  const direct = plan.directMembers || {};
  const map = {};

  if (plan.orgId && planShareState.orgMembersCache[plan.orgId]) {
    planShareState.orgMembersCache[plan.orgId].forEach(m => {
      map[m.id] = { uid: m.id, role: m.role, source: 'org', displayName: m.displayName, email: m.email, photoURL: m.photoURL };
    });
  }
  Object.keys(direct).forEach(uid => {
    const existing = map[uid];
    const profile = planShareState.directProfiles[uid];
    map[uid] = {
      uid,
      role: direct[uid],
      source: 'direct',
      displayName: (existing && existing.displayName) || (profile && profile.displayName) || uid,
      email: (existing && existing.email) || (profile && profile.email) || '',
      photoURL: (existing && existing.photoURL) || (profile && profile.photoURL) || '',
    };
  });
  return Object.values(map);
}

function computePlanAdminCount() {
  return computePlanMembers().filter(m => m.role === 'admin').length;
}

async function _loadPlanMemberProfiles(uids) {
  for (const uid of uids) {
    if (planShareState.directProfiles[uid]) continue;
    planShareState.directProfiles[uid] = { displayName: uid, email: '', photoURL: '' }; // placeholder, avoids refetch loop
    try {
      const snap = await fbDb.collection('userProfiles').doc(uid).get();
      if (snap.exists) planShareState.directProfiles[uid] = snap.data();
    } catch (e) { console.warn('Could not load profile for', uid, e); }
  }
  renderPlanShareMemberList();
}

// ── Change role / remove / leave ─────────────────────────────────────────────

async function changePlanMemberRole(uid, newRole) {
  const planId = planShareState.currentPlanId;
  if (!planId || !currentUser || uid === currentUser.uid) return;
  try {
    await fbDb.collection('plans').doc(planId).update({ [`directMembers.${uid}`]: newRole });
    showNotif('Role updated', 'success');
  } catch (e) {
    console.warn(e);
    showNotif('Could not update role', 'error');
  }
}

async function removePlanMember(uid) {
  const planId = planShareState.currentPlanId;
  if (!planId) return;
  try {
    await fbDb.collection('plans').doc(planId).update({ [`directMembers.${uid}`]: firebase.firestore.FieldValue.delete() });
    showNotif('Member removed', 'success');
  } catch (e) {
    console.warn(e);
    showNotif('Could not remove member', 'error');
  }
}

function confirmRemovePlanMember(uid, name) {
  showConfirm('Remove Member', `Remove ${name} from this plan?`, () => removePlanMember(uid));
}

async function leavePlan() {
  const planId = planShareState.currentPlanId;
  const plan = planShareState.currentPlan;
  if (!planId || !plan || !currentUser) return;
  const direct = plan.directMembers || {};

  if (!(currentUser.uid in direct)) {
    showNotif('Your access comes from an organization — ask an Admin to remove you, or leave the organization instead.', 'error');
    return;
  }
  if (direct[currentUser.uid] === 'admin' && computePlanAdminCount() <= 1) {
    showNotif('You are the only Admin — promote someone else before leaving', 'error');
    return;
  }
  try {
    await fbDb.collection('plans').doc(planId).update({ [`directMembers.${currentUser.uid}`]: firebase.firestore.FieldValue.delete() });
    showNotif('You left the plan', 'success');
    closeSharePlanModal();
    renderPlannerProjects();
  } catch (e) {
    console.warn(e);
    showNotif('Could not leave plan', 'error');
  }
}

function confirmLeavePlan() {
  showConfirm('Leave Plan', `Leave this plan? You'll lose access unless re-added.`, leavePlan);
}

// ── Org attach / detach ───────────────────────────────────────────────────────

async function detachPlanOrg() {
  const planId = planShareState.currentPlanId;
  if (!planId) return;
  try {
    await fbDb.collection('plans').doc(planId).update({ orgId: null });
    showNotif('Organization detached', 'success');
  } catch (e) {
    console.warn(e);
    showNotif('Could not detach organization', 'error');
  }
}

function confirmDetachPlanOrg() {
  showConfirm(
    'Detach Organization',
    'Detach this organization from the plan? Members added individually will keep their access.',
    detachPlanOrg
  );
}

// ── Org-member picker popup (§5) ─────────────────────────────────────────────

async function openOrgPickerForPlan(orgId) {
  planShareState.orgPicker.orgId = orgId;
  planShareState.orgPicker.search = '';
  planShareState.orgPicker.selected = new Set();
  planShareState.orgPicker.roles = {};

  const searchInput = document.getElementById('plan-orgpicker-search');
  if (searchInput) searchInput.value = '';
  const searchClear = document.getElementById('plan-orgpicker-search-clear');
  if (searchClear) searchClear.style.display = 'none';

  const org = orgState.myOrgs.find(o => o.orgId === orgId);
  document.getElementById('plan-orgpicker-title').textContent = org ? `Add Members from ${org.orgName}` : 'Add Organization Members';

  try {
    const snap = await fbDb.collection('organizations').doc(orgId).collection('members').get();
    planShareState.orgPicker.members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn(e);
    showNotif('Could not load organization members', 'error');
    planShareState.orgPicker.members = [];
  }

  // Pre-select + preset the roles of anyone already directly added to this plan
  const direct = (planShareState.currentPlan && planShareState.currentPlan.directMembers) || {};
  planShareState.orgPicker.members.forEach(m => {
    planShareState.orgPicker.roles[m.id] = direct[m.id] || m.role;
    if (direct[m.id]) planShareState.orgPicker.selected.add(m.id);
  });

  document.getElementById('plan-orgpicker-modal').style.display = 'flex';
  renderOrgPickerList();
}

function closeOrgPickerModal() {
  document.getElementById('plan-orgpicker-modal').style.display = 'none';
}

function renderOrgPickerList() {
  const list = document.getElementById('plan-orgpicker-list');
  if (!list) return;
  const q = planShareState.orgPicker.search.trim().toLowerCase();
  let members = planShareState.orgPicker.members.slice();
  if (q) {
    members = members.filter(m =>
      (m.displayName || '').toLowerCase().includes(q) ||
      (m.email || '').toLowerCase().includes(q)
    );
  }

  if (!members.length) {
    list.innerHTML = `<div class="empty-state"><p>${q ? 'No members match your search.' : 'This organization has no members.'}</p></div>`;
    return;
  }

  list.innerHTML = members.map(m => {
    const checked = planShareState.orgPicker.selected.has(m.id);
    const role = planShareState.orgPicker.roles[m.id] || m.role;
    return `
      <div class="task-card">
        <input type="checkbox" ${checked ? 'checked' : ''}
          style="cursor:pointer;accent-color:var(--accent);width:16px;height:16px;flex-shrink:0"
          onchange="_toggleOrgPickerMember('${m.id}', this.checked)" />
        ${_avatarHTML(m.photoURL, m.displayName, 34)}
        <div class="task-card-info">
          <div class="task-card-name">${_orgEsc(m.displayName || m.email)}</div>
          <div class="task-card-meta"><span>${_orgEsc(m.email)}</span></div>
        </div>
        <select class="setting-input org-role-select" style="flex-shrink:0" onchange="_setOrgPickerRole('${m.id}', this.value)">
          ${ROLE_ORDER.map(r => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
        </select>
      </div>`;
  }).join('');
}

function _toggleOrgPickerMember(uid, checked) {
  if (checked) planShareState.orgPicker.selected.add(uid);
  else planShareState.orgPicker.selected.delete(uid);
}

function _setOrgPickerRole(uid, role) {
  planShareState.orgPicker.roles[uid] = role;
}

function orgPickerSelectAll() {
  planShareState.orgPicker.members.forEach(m => planShareState.orgPicker.selected.add(m.id));
  renderOrgPickerList();
}

function orgPickerDeselectAll() {
  planShareState.orgPicker.selected.clear();
  renderOrgPickerList();
}

async function confirmOrgPickerAttach() {
  const planId = planShareState.currentPlanId;
  const orgId = planShareState.orgPicker.orgId;
  if (!planId || !orgId) return;

  const updates = { orgId };
  planShareState.orgPicker.selected.forEach(uid => {
    updates[`directMembers.${uid}`] = planShareState.orgPicker.roles[uid] || 'visitor';
  });

  try {
    await fbDb.collection('plans').doc(planId).update(updates);
    showNotif('Organization members added', 'success');
    closeOrgPickerModal();
    await migratePlanDataToFirestore(planId);
  } catch (e) {
    console.warn(e);
    showNotif('Could not add members', 'error');
  }
}

// ── Add an individual (non-org) member by email ──────────────────────────────

async function lookupPlanAddMember() {
  const emailInput = document.getElementById('plan-share-addmember-email');
  const btn = document.getElementById('plan-share-addmember-lookup');
  const resultEl = document.getElementById('plan-share-addmember-result');
  const notFoundEl = document.getElementById('plan-share-addmember-notfound');

  resultEl.style.display = 'none';
  notFoundEl.style.display = 'none';
  planShareState.addMemberLookupResult = null;

  const email = emailInput.value.trim();
  if (!email) { showNotif('Enter a Gmail address', 'error'); return; }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Searching…';
  try {
    const profile = await lookupUserProfileByEmail(email);
    const plan = planShareState.currentPlan;
    if (!profile) {
      notFoundEl.textContent = 'No account found for this email.';
      notFoundEl.style.display = 'block';
    } else if (plan && plan.directMembers && plan.directMembers[profile.uid]) {
      notFoundEl.textContent = 'This person already has access to this plan.';
      notFoundEl.style.display = 'block';
    } else {
      resultEl.innerHTML = `
        <div class="task-card">
          ${_avatarHTML(profile.photoURL, profile.displayName, 40)}
          <div class="task-card-info">
            <div class="task-card-name">${_orgEsc(profile.displayName)}</div>
            <div class="task-card-meta"><span>${_orgEsc(profile.email)}</span></div>
          </div>
          <button class="btn-primary" style="padding:6px 12px;font-size:12px;flex-shrink:0" onclick="confirmAddPlanMember()">Add as Visitor</button>
        </div>`;
      resultEl.style.display = 'block';
      planShareState.addMemberLookupResult = profile;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function confirmAddPlanMember() {
  const profile = planShareState.addMemberLookupResult;
  const planId = planShareState.currentPlanId;
  if (!profile || !planId) return;
  try {
    await fbDb.collection('plans').doc(planId).update({ [`directMembers.${profile.uid}`]: 'visitor' });
    planShareState.directProfiles[profile.uid] = profile;
    showNotif(`${profile.displayName || profile.email} added as Visitor`, 'success');
    closePlanAddMemberResult();
    await migratePlanDataToFirestore(planId);
  } catch (e) {
    console.warn(e);
    showNotif('Could not add member', 'error');
  }
}

function closePlanAddMemberResult() {
  const emailInput = document.getElementById('plan-share-addmember-email');
  if (emailInput) emailInput.value = '';
  const resultEl = document.getElementById('plan-share-addmember-result');
  if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
  const notFoundEl = document.getElementById('plan-share-addmember-notfound');
  if (notFoundEl) notFoundEl.style.display = 'none';
  planShareState.addMemberLookupResult = null;
}

// ── Rendering: Share Plan modal ───────────────────────────────────────────────

function renderPlanShareOrgsList() {
  const el = document.getElementById('plan-share-orgs-list');
  if (!el) return;

  if (!orgState.myOrgs.length) {
    el.innerHTML = `<div class="empty-state"><p>You're not part of any organizations yet.</p></div>`;
    return;
  }

  const plan = planShareState.currentPlan || {};
  el.innerHTML = orgState.myOrgs.map(o => {
    const isAttached = plan.orgId === o.orgId;
    return `
      <div class="task-card" style="padding:10px 14px">
        <div class="task-card-info">
          <div class="task-card-name">${_orgEsc(o.orgName)}${isAttached ? ' <span style="color:#10b981;font-weight:600;font-size:11px">· Attached</span>' : ''}</div>
          <div class="task-card-meta"><span>Your role: ${ROLE_LABELS[o.role] || o.role}</span></div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn-secondary" style="padding:6px 12px;font-size:12px" onclick="openOrgPickerForPlan('${o.orgId}')">
            ${isAttached ? 'Manage members' : 'Add members'}
          </button>
          ${isAttached ? `<button class="task-btn delete" title="Detach organization" onclick="confirmDetachPlanOrg()">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderPlanShareMemberList() {
  const list = document.getElementById('plan-share-member-list');
  if (!list || !planShareState.currentPlan) return;

  const myRole = computeMyPlanRole();
  const isAdmin = myRole === 'admin';
  const q = planShareState.memberSearch.trim().toLowerCase();

  // Lazily resolve display info for direct members not covered by an
  // attached org's (already-live) member list.
  const orgMembers = (planShareState.currentPlan.orgId && planShareState.orgMembersCache[planShareState.currentPlan.orgId]) || [];
  const missingUids = Object.keys(planShareState.currentPlan.directMembers || {})
    .filter(uid => !planShareState.directProfiles[uid] && !orgMembers.some(m => m.id === uid));
  if (missingUids.length) _loadPlanMemberProfiles(missingUids);

  let members = computePlanMembers().sort((a, b) => ROLE_ORDER.indexOf(b.role) - ROLE_ORDER.indexOf(a.role));
  if (q) {
    members = members.filter(m =>
      (m.displayName || '').toLowerCase().includes(q) ||
      (m.email || '').toLowerCase().includes(q)
    );
  }

  if (!members.length) {
    list.innerHTML = `<div class="empty-state"><p>${q ? 'No members match your search.' : 'No members yet.'}</p></div>`;
  } else {
    list.innerHTML = members.map(m => {
      const isMe = currentUser && m.uid === currentUser.uid;
      const roleCell = (isAdmin && !isMe)
        ? `<select class="setting-input org-role-select" onchange="changePlanMemberRole('${m.uid}', this.value)">
            ${ROLE_ORDER.map(r => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
          </select>`
        : _roleBadgeHTML(m.role);
      // Members whose access is purely an org default (no directMembers
      // override) can't be individually "removed" — detach the org, or
      // change their role here to give them an explicit override first.
      const canRemove = isAdmin && !isMe && m.source === 'direct';
      const actionCell = canRemove
        ? `<button class="task-btn delete" title="Remove member" onclick="confirmRemovePlanMember('${m.uid}','${_orgEsc(m.displayName || m.email).replace(/'/g, "\\'")}')">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>`
        : '';
      const sourceTag = m.source === 'org' ? `<span style="color:var(--text-muted);font-size:11px"> · via org</span>` : '';

      return `
        <div class="task-card">
          ${_avatarHTML(m.photoURL, m.displayName, 34)}
          <div class="task-card-info">
            <div class="task-card-name">${_orgEsc(m.displayName || m.email)}${isMe ? ' <span style="color:var(--text-muted);font-weight:400">(you)</span>' : ''}${sourceTag}</div>
            <div class="task-card-meta"><span>${_orgEsc(m.email)}</span></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
            ${roleCell}
            ${actionCell}
          </div>
        </div>`;
    }).join('');
  }

  const leaveBtn = document.getElementById('plan-share-leave');
  if (leaveBtn) leaveBtn.style.display = myRole ? 'inline-flex' : 'none';
}

function renderSharePlanModal() {
  if (!planShareState.currentPlan) return;
  const titleEl = document.getElementById('plan-share-title');
  if (titleEl) titleEl.textContent = `Share "${planShareState.currentPlan.name || 'Plan'}"`;
  renderPlanShareOrgsList();
  renderPlanShareMemberList();
}

// ── Open / close the Share Plan modal ────────────────────────────────────────

async function openSharePlanModal(planId) {
  if (!currentUser) { showNotif('Sign in to share this plan', 'error'); return; }

  planShareState.currentPlanId = planId;
  planShareState.memberSearch = '';
  const searchInput = document.getElementById('plan-share-member-search');
  if (searchInput) searchInput.value = '';
  const searchClear = document.getElementById('plan-share-member-search-clear');
  if (searchClear) searchClear.style.display = 'none';
  closePlanAddMemberResult();

  document.getElementById('plan-share-title').textContent = 'Share Plan…';
  document.getElementById('plan-share-modal').style.display = 'flex';

  const plan = await ensurePlanDoc(planId);
  if (!plan) {
    showNotif('Could not open sharing settings', 'error');
    closeSharePlanModal();
    return;
  }
  planShareState.currentPlan = plan;
  startPlanListener(planId);
  renderSharePlanModal();
}

function closeSharePlanModal() {
  document.getElementById('plan-share-modal').style.display = 'none';
  stopPlanListener();
  planShareState.currentPlanId = null;
  planShareState.currentPlan = null;
}

// ── Shared Plan Data — versions & tasks (Phase 2 continuation) ──────────────
// See docs/ORGANIZATIONS_AND_ROLES.md §3. Until a plan is actually shared,
// its versions/tasks stay exactly where they've always lived: inside the
// single per-user blob (users/{uid}, via plannerState + saveData() in
// app.js). Once a plan gets its first collaborator — an org attached, or a
// directMembers entry beyond the creator — its versions/tasks move into:
//   plans/{planId}/versions/{versionId}
//   plans/{planId}/versions/{versionId}/tasks/{taskId}
// Each task doc also carries a redundant `planId` field, kept for possible
// future server-side use — it is NOT used to power the live listener below.
// A collectionGroup('tasks') query filtered by planId looks tempting (one
// listener instead of one per version), but Firestore blanket-denies an
// entire collection-group list if the applicable security rule contains a
// get()/exists() call anywhere — and the tasks rule needs isPlanMember(),
// which calls get(). So the live listener below uses one plain listener
// per version instead (see startSharedPlanDataListeners()).
//
// plannerState.versions / plannerState.plannerTasks stay the ONE thing the
// UI (renderBoard, renderPlannerProjects, etc. in app.js) reads from either
// way — for a migrated project those arrays are populated by the live
// listeners below instead of loadData(). All planner mutation call sites in
// app.js route through the upsert/delete/reorder functions below instead of
// touching plannerState.versions/plannerTasks + savePlannerData() directly,
// so "local blob vs. Firestore" is decided in exactly one place per call.

const sharedPlanData = {
  activePlanId: null,
  _unsubVersions: null,
  _unsubTasksByVersion: {}, // versionId -> unsub fn — see note on startSharedPlanDataListeners()
};

function isProjectMigrated(projectId) {
  const proj = plannerState.projects.find(p => p.id === projectId);
  return !!(proj && proj.dataMigrated);
}

// Call once, right after a plan first becomes shared — moves any existing
// local versions/tasks for this project into Firestore, then flips
// plannerState.projects[].dataMigrated so every future mutation for this
// project routes to Firestore instead of the local blob. Idempotent.
async function migratePlanDataToFirestore(planId) {
  if (!fbDb || !currentUser) return false;
  if (isProjectMigrated(planId)) return true;

  const proj = plannerState.projects.find(p => p.id === planId);
  if (!proj) return false;

  const versions = plannerState.versions.filter(v => v.projectId === planId);
  const versionIds = new Set(versions.map(v => v.id));
  const tasks = plannerState.plannerTasks.filter(t => versionIds.has(t.versionId));

  try {
    const batch = fbDb.batch();
    const versionsRef = fbDb.collection('plans').doc(planId).collection('versions');
    versions.forEach(v => {
      const { projectId, ...rest } = v; // projectId is implicit in the path now
      batch.set(versionsRef.doc(v.id), rest);
    });
    tasks.forEach(t => {
      batch.set(versionsRef.doc(t.versionId).collection('tasks').doc(t.id), { ...t, planId });
    });
    batch.update(fbDb.collection('plans').doc(planId), { dataMigrated: true });
    await batch.commit();

    // Drop the now-Firestore-backed entries from the local blob and mark
    // the project migrated (this flag lives on the local project object
    // too, so reopening the app doesn't need a round-trip to know).
    plannerState.versions = plannerState.versions.filter(v => v.projectId !== planId);
    const taskIds = new Set(tasks.map(t => t.id));
    plannerState.plannerTasks = plannerState.plannerTasks.filter(t => !taskIds.has(t.id));
    proj.dataMigrated = true;
    await savePlannerData();
    return true;
  } catch (e) {
    console.warn('Could not migrate plan data to Firestore:', e);
    showNotif('Could not move this plan to shared storage — try again', 'error');
    return false;
  }
}

// Live sync for a migrated project's board: mirrors plans/{planId}/versions
// and every task under it into plannerState.versions/plannerTasks. Call
// when opening a migrated project's board; stop when leaving it.
// Live sync for a migrated project's board: mirrors plans/{planId}/versions
// and every task under it into plannerState.versions/plannerTasks. Call
// when opening a migrated project's board; stop when leaving it.
//
// NOTE on tasks: this deliberately does NOT use a collectionGroup('tasks')
// query. Firestore blanket-denies an entire collection-group list if the
// applicable security rule contains a get()/exists() call anywhere (see the
// long note at the top of firestore.rules) — and the tasks rule needs
// isPlanMember(planId), which calls get(). So instead this keeps one plain
// listener per version on plans/{planId}/versions/{versionId}/tasks, added
// and removed as the plan's versions come and go — the same workaround
// pattern as userOrgMemberships in org.js.
function startSharedPlanDataListeners(planId) {
  stopSharedPlanDataListeners();
  sharedPlanData.activePlanId = planId;

  sharedPlanData._unsubVersions = fbDb.collection('plans').doc(planId).collection('versions')
    .onSnapshot(snap => {
      const others = plannerState.versions.filter(v => v.projectId !== planId);
      const mine = snap.docs.map(d => ({ id: d.id, projectId: planId, ...d.data() }));
      plannerState.versions = [...others, ...mine];
      _syncSharedPlanTaskListeners(planId, mine.map(v => v.id));
      if (plannerState.currentProjectId === planId) renderBoard();
    }, err => console.warn('Shared plan versions listener error:', err));
}

// Starts a tasks listener for any version we don't already have one for,
// and stops/cleans up listeners for versions that no longer exist — keeps
// the live set in sync with the plan's current versions without ever
// touching collectionGroup().
function _syncSharedPlanTaskListeners(planId, currentVersionIds) {
  const wanted = new Set(currentVersionIds);
  const have = sharedPlanData._unsubTasksByVersion;

  Object.keys(have).forEach(versionId => {
    if (!wanted.has(versionId)) {
      have[versionId]();
      delete have[versionId];
      plannerState.plannerTasks = plannerState.plannerTasks.filter(t => t.versionId !== versionId);
    }
  });

  wanted.forEach(versionId => {
    if (have[versionId]) return;
    have[versionId] = fbDb.collection('plans').doc(planId).collection('versions').doc(versionId)
      .collection('tasks')
      .onSnapshot(snap => {
        const others = plannerState.plannerTasks.filter(t => t.versionId !== versionId);
        const mine = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        plannerState.plannerTasks = [...others, ...mine];
        if (plannerState.currentProjectId === planId) renderBoard();
      }, err => console.warn('Shared plan tasks listener error:', err));
  });
}

function stopSharedPlanDataListeners() {
  if (sharedPlanData._unsubVersions) { sharedPlanData._unsubVersions(); sharedPlanData._unsubVersions = null; }
  Object.values(sharedPlanData._unsubTasksByVersion).forEach(unsub => unsub());
  sharedPlanData._unsubTasksByVersion = {};
  sharedPlanData.activePlanId = null;
}

// ── Version/task writes — Firestore for a migrated plan, local array +
// savePlannerData() otherwise. ────────────────────────────────────────────

async function upsertPlannerVersion(projectId, version) {
  if (isProjectMigrated(projectId)) {
    const { projectId: _drop, ...rest } = version;
    try {
      await fbDb.collection('plans').doc(projectId).collection('versions').doc(version.id).set(rest, { merge: true });
    } catch (e) {
      console.warn(e);
      showNotif('Could not save version — check your permissions', 'error');
    }
    // No local write here: the live listener reflects this back into
    // plannerState.versions once Firestore confirms it.
  } else {
    const idx = plannerState.versions.findIndex(v => v.id === version.id);
    if (idx === -1) plannerState.versions.push(version);
    else plannerState.versions[idx] = version;
    await savePlannerData();
  }
}

async function deletePlannerVersion(projectId, versionId) {
  if (isProjectMigrated(projectId)) {
    try {
      const versionRef = fbDb.collection('plans').doc(projectId).collection('versions').doc(versionId);
      const tasksSnap = await versionRef.collection('tasks').get();
      const batch = fbDb.batch();
      tasksSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(versionRef);
      await batch.commit();
    } catch (e) {
      console.warn(e);
      showNotif('Could not delete version — check your permissions', 'error');
    }
  } else {
    plannerState.plannerTasks = plannerState.plannerTasks.filter(t => t.versionId !== versionId);
    plannerState.versions = plannerState.versions.filter(v => v.id !== versionId);
    await savePlannerData();
  }
}

async function reorderPlannerVersions(projectId, orderedVersionIds) {
  if (isProjectMigrated(projectId)) {
    try {
      const batch = fbDb.batch();
      const versionsRef = fbDb.collection('plans').doc(projectId).collection('versions');
      orderedVersionIds.forEach((vid, idx) => batch.update(versionsRef.doc(vid), { order: idx }));
      await batch.commit();
    } catch (e) { console.warn(e); showNotif('Could not reorder versions', 'error'); }
  } else {
    orderedVersionIds.forEach((vid, idx) => {
      const ver = plannerState.versions.find(v => v.id === vid);
      if (ver) ver.order = idx;
    });
    await savePlannerData();
  }
}

async function upsertPlannerTask(projectId, versionId, task) {
  if (isProjectMigrated(projectId)) {
    try {
      await fbDb.collection('plans').doc(projectId).collection('versions').doc(versionId)
        .collection('tasks').doc(task.id).set({ ...task, planId: projectId }, { merge: true });
    } catch (e) {
      console.warn(e);
      showNotif('Could not save task — check your permissions', 'error');
    }
  } else {
    const idx = plannerState.plannerTasks.findIndex(t => t.id === task.id);
    if (idx === -1) plannerState.plannerTasks.push(task);
    else plannerState.plannerTasks[idx] = task;
    await savePlannerData();
  }
}

async function deletePlannerTask(projectId, versionId, taskId) {
  if (isProjectMigrated(projectId)) {
    try {
      await fbDb.collection('plans').doc(projectId).collection('versions').doc(versionId)
        .collection('tasks').doc(taskId).delete();
    } catch (e) {
      console.warn(e);
      showNotif('Could not delete task — check your permissions', 'error');
    }
  } else {
    plannerState.plannerTasks = plannerState.plannerTasks.filter(t => t.id !== taskId);
    await savePlannerData();
  }
}

async function reorderPlannerTasks(projectId, versionId, orderedTaskIds) {
  if (isProjectMigrated(projectId)) {
    try {
      const batch = fbDb.batch();
      const tasksRef = fbDb.collection('plans').doc(projectId).collection('versions').doc(versionId).collection('tasks');
      orderedTaskIds.forEach((tid, idx) => batch.update(tasksRef.doc(tid), { order: idx }));
      await batch.commit();
    } catch (e) { console.warn(e); showNotif('Could not reorder tasks', 'error'); }
  } else {
    orderedTaskIds.forEach((tid, idx) => {
      const t = plannerState.plannerTasks.find(t => t.id === tid);
      if (t) t.order = idx;
    });
    await savePlannerData();
  }
}

// Firestore has no native "move to a different subcollection parent" — a
// cross-version drag is a delete-under-old-version + create-under-new-version
// in one batch, keeping the same task id.
async function movePlannerTaskToVersion(projectId, task, newVersionId, newOrder) {
  if (isProjectMigrated(projectId)) {
    const oldVersionId = task.versionId;
    try {
      const versionsRef = fbDb.collection('plans').doc(projectId).collection('versions');
      const oldRef = versionsRef.doc(oldVersionId).collection('tasks').doc(task.id);
      const newRef = versionsRef.doc(newVersionId).collection('tasks').doc(task.id);
      const batch = fbDb.batch();
      batch.delete(oldRef);
      batch.set(newRef, { ...task, versionId: newVersionId, order: newOrder, planId: projectId });
      await batch.commit();
    } catch (e) { console.warn(e); showNotif('Could not move task', 'error'); }
  } else {
    task.versionId = newVersionId;
    task.order = newOrder;
    await savePlannerData();
  }
}

// Called from the project-delete flow in renderPlannerProjects() in
// addition to (not instead of) the local-array cleanup that already
// happens at that call site — wipes the Firestore-backed versions/tasks
// and the plans/{planId} doc itself for a migrated project.
async function deletePlannerProjectData(projectId) {
  if (!isProjectMigrated(projectId)) return;
  try {
    const versionsSnap = await fbDb.collection('plans').doc(projectId).collection('versions').get();
    const batch = fbDb.batch();
    for (const vDoc of versionsSnap.docs) {
      const tasksSnap = await vDoc.ref.collection('tasks').get();
      tasksSnap.docs.forEach(d => batch.delete(d.ref));
      batch.delete(vDoc.ref);
    }
    batch.delete(fbDb.collection('plans').doc(projectId));
    await batch.commit();
  } catch (e) {
    console.warn('Could not delete shared plan data:', e);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function _initPlanSharingModule() {
  document.getElementById('plan-share-close')?.addEventListener('click', closeSharePlanModal);
  document.getElementById('plan-share-done')?.addEventListener('click', closeSharePlanModal);
  document.getElementById('plan-share-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSharePlanModal();
  });
  document.getElementById('plan-share-leave')?.addEventListener('click', confirmLeavePlan);

  document.getElementById('plan-share-addmember-lookup')?.addEventListener('click', lookupPlanAddMember);
  document.getElementById('plan-share-addmember-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookupPlanAddMember(); }
  });

  const searchInput = document.getElementById('plan-share-member-search');
  const searchClear = document.getElementById('plan-share-member-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      planShareState.memberSearch = searchInput.value;
      if (searchClear) searchClear.style.display = searchInput.value ? 'flex' : 'none';
      renderPlanShareMemberList();
    });
  }
  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      planShareState.memberSearch = '';
      searchClear.style.display = 'none';
      renderPlanShareMemberList();
    });
  }

  // Org picker modal
  document.getElementById('plan-orgpicker-close')?.addEventListener('click', closeOrgPickerModal);
  document.getElementById('plan-orgpicker-cancel')?.addEventListener('click', closeOrgPickerModal);
  document.getElementById('plan-orgpicker-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeOrgPickerModal();
  });
  document.getElementById('plan-orgpicker-selectall')?.addEventListener('click', orgPickerSelectAll);
  document.getElementById('plan-orgpicker-deselectall')?.addEventListener('click', orgPickerDeselectAll);
  document.getElementById('plan-orgpicker-confirm')?.addEventListener('click', confirmOrgPickerAttach);

  const opSearch = document.getElementById('plan-orgpicker-search');
  const opClear = document.getElementById('plan-orgpicker-search-clear');
  if (opSearch) {
    opSearch.addEventListener('input', () => {
      planShareState.orgPicker.search = opSearch.value;
      if (opClear) opClear.style.display = opSearch.value ? 'flex' : 'none';
      renderOrgPickerList();
    });
  }
  if (opClear) {
    opClear.addEventListener('click', () => {
      opSearch.value = '';
      planShareState.orgPicker.search = '';
      opClear.style.display = 'none';
      renderOrgPickerList();
    });
  }
}

_initPlanSharingModule();
