/* =========================================================================
   app.js
   ------
   منطق الواجهة الأمامية بالكامل:
     - تسجيل الدخول / إنشاء حساب
     - محادثات ثنائية ومكالمات صوتية ثنائية (WebRTC مباشر)
     - مجموعات: إنشاء، رسائل جماعية، ومكالمات جماعية (Mesh WebRTC)

   لا حاجة لأي مكتبة خارجية: WebSocket و WebRTC مدعومتان أصلًا في المتصفح.
   ========================================================================= */

(() => {
  "use strict";

  // -----------------------------------------------------------------------
  // الحالة العامة
  // -----------------------------------------------------------------------
  const state = {
    token: localStorage.getItem("lvc_token") || null,
    userId: localStorage.getItem("lvc_user_id") ? Number(localStorage.getItem("lvc_user_id")) : null,
    username: localStorage.getItem("lvc_username") || null,

    ws: null,
    wsReconnectTimer: null,

    users: new Map(),   // id -> {id, username, status, last_seen}
    groups: new Map(),  // id -> {id, name, created_by, member_count}

    // المحادثة المفتوحة حاليًا في الشاشة الرئيسية
    selectedChat: null, // {type: "user"|"group", id}

    // ---- مكالمة ثنائية (1:1) ----
    pc: null,
    localStream: null,
    activeCallPeerId: null,
    pendingOffer: null,
    pendingRemoteCandidates: [],

    // ---- مكالمة جماعية (Mesh) ----
    activeGroupCall: null, // {groupId, callId}
    groupPeerConnections: new Map(),  // peerId -> RTCPeerConnection
    groupPendingCandidates: new Map(), // peerId -> [candidate, ...]
    groupParticipants: new Map(), // peerId -> username (يشمل نفسي بعد الانضمام)
    micMuted: false,
  };

  const RTC_CONFIG = { iceServers: [] }; // شبكة محلية واحدة: لا حاجة لـ STUN/TURN خارجي

  // -----------------------------------------------------------------------
  // مراجع DOM
  // -----------------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  const authScreen = el("auth-screen");
  const appScreen = el("app-screen");

  const loginForm = el("login-form");
  const registerForm = el("register-form");
  const loginError = el("login-error");
  const registerError = el("register-error");

  const meUsernameEl = el("me-username");
  const usersListEl = el("users-list");
  const groupsListEl = el("groups-list");

  const noChatSelected = el("no-chat-selected");
  const chatActive = el("chat-active");
  const peerUsernameEl = el("peer-username");
  const peerStatusDot = el("peer-status-dot");
  const peerSubtitleEl = el("peer-subtitle");
  const messagesEl = el("messages");
  const messageForm = el("message-form");
  const messageInput = el("message-input");
  const callBtn = el("call-btn");

  // مكالمة ثنائية
  const callOverlay = el("call-overlay");
  const callPeerNameEl = el("call-peer-name");
  const callStatusTextEl = el("call-status-text");
  const callAcceptBtn = el("call-accept-btn");
  const callRejectBtn = el("call-reject-btn");
  const callEndBtn = el("call-end-btn");

  // مكالمة جماعية
  const groupCallBar = el("group-call-bar");
  const gcbTitle = el("gcb-title");
  const gcbParticipants = el("gcb-participants");
  const gcbMuteBtn = el("gcb-mute-btn");
  const gcbLeaveBtn = el("gcb-leave-btn");
  const groupInviteBanner = el("group-invite-banner");
  const groupInviteText = el("group-invite-text");
  const groupInviteJoinBtn = el("group-invite-join-btn");
  const groupInviteDismissBtn = el("group-invite-dismiss-btn");

  // نافذة إنشاء مجموعة
  const newGroupModal = el("new-group-modal");
  const newGroupNameInput = el("new-group-name");
  const newGroupMembersEl = el("new-group-members");
  const newGroupError = el("new-group-error");

  const remoteAudiosContainer = el("remote-audios-container");
  const toastEl = el("toast");

  // -----------------------------------------------------------------------
  // أدوات مساعدة عامة
  // -----------------------------------------------------------------------

  function showToast(message, ms = 3000) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["Authorization"] = `Bearer ${state.token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401) {
      logout(false);
      throw new Error("انتهت الجلسة، سجّل الدخول من جديد");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "حدث خطأ غير متوقع");
    return data;
  }

  function formatTime(isoString) {
    try {
      const d = new Date(isoString + "Z");
      return d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // -----------------------------------------------------------------------
  // تبديل التبويبات (دخول / حساب جديد)
  // -----------------------------------------------------------------------

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      loginForm.classList.toggle("hidden", tab !== "login");
      registerForm.classList.toggle("hidden", tab !== "register");
      loginError.textContent = "";
      registerError.textContent = "";
    });
  });

  // -----------------------------------------------------------------------
  // المصادقة
  // -----------------------------------------------------------------------

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    const fd = new FormData(loginForm);
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: { username: fd.get("username"), password: fd.get("password") },
      });
      onAuthSuccess(data);
    } catch (err) {
      loginError.textContent = err.message;
    }
  });

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    registerError.textContent = "";
    const fd = new FormData(registerForm);
    try {
      const data = await api("/api/register", {
        method: "POST",
        body: { username: fd.get("username"), password: fd.get("password") },
      });
      onAuthSuccess(data);
    } catch (err) {
      registerError.textContent = err.message;
    }
  });

  function onAuthSuccess({ token, user_id, username }) {
    state.token = token;
    state.userId = user_id;
    state.username = username;
    localStorage.setItem("lvc_token", token);
    localStorage.setItem("lvc_user_id", String(user_id));
    localStorage.setItem("lvc_username", username);
    enterApp();
  }

  function logout(notifyServer = true) {
    if (notifyServer) api("/api/logout", { method: "POST" }).catch(() => {});
    if (state.ws) { state.ws.close(); state.ws = null; }
    clearTimeout(state.wsReconnectTimer);

    endCallLocally();
    leaveGroupCallLocally();

    state.token = null;
    state.userId = null;
    state.username = null;
    localStorage.removeItem("lvc_token");
    localStorage.removeItem("lvc_user_id");
    localStorage.removeItem("lvc_username");

    appScreen.classList.add("hidden");
    authScreen.classList.remove("hidden");
    loginForm.reset();
    registerForm.reset();
  }

  el("logout-btn").addEventListener("click", () => logout(true));

  // -----------------------------------------------------------------------
  // دخول التطبيق الرئيسي
  // -----------------------------------------------------------------------

  async function enterApp() {
    authScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    meUsernameEl.textContent = state.username;

    await Promise.all([refreshUsers(), refreshGroups()]);
    connectWebSocket();
  }

  async function refreshUsers() {
    try {
      const users = await api("/api/users");
      state.users.clear();
      users.forEach((u) => state.users.set(u.id, u));
      renderUsersList();
    } catch (err) {
      showToast(err.message);
    }
  }

  async function refreshGroups() {
    try {
      const groups = await api("/api/groups");
      state.groups.clear();
      groups.forEach((g) => state.groups.set(g.id, g));
      renderGroupsList();
    } catch (err) {
      showToast(err.message);
    }
  }

  // -----------------------------------------------------------------------
  // عرض القوائم الجانبية
  // -----------------------------------------------------------------------

  function renderUsersList() {
    usersListEl.innerHTML = "";
    if (state.users.size === 0) {
      usersListEl.innerHTML = `<div class="users-empty">لا يوجد مستخدمون آخرون بعد</div>`;
      return;
    }
    const sorted = [...state.users.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === "online" ? -1 : 1;
      return a.username.localeCompare(b.username, "ar");
    });

    for (const u of sorted) {
      const isSelected = state.selectedChat && state.selectedChat.type === "user" && state.selectedChat.id === u.id;
      const row = document.createElement("div");
      row.className = "user-row" + (isSelected ? " selected" : "");
      row.innerHTML = `
        <span class="status-dot ${u.status === "online" ? "online" : ""}"></span>
        <span class="u-name">${escapeHtml(u.username)}</span>
        <span class="u-freq">${u.status === "online" ? "متصل" : "غير متصل"}</span>
      `;
      row.addEventListener("click", () => selectChat("user", u.id));
      usersListEl.appendChild(row);
    }
  }

  function renderGroupsList() {
    groupsListEl.innerHTML = "";
    if (state.groups.size === 0) {
      groupsListEl.innerHTML = `<div class="users-empty">لا توجد مجموعات بعد</div>`;
      return;
    }
    for (const g of state.groups.values()) {
      const isSelected = state.selectedChat && state.selectedChat.type === "group" && state.selectedChat.id === g.id;
      const isLive = state.activeGroupCall && state.activeGroupCall.groupId === g.id;
      const row = document.createElement("div");
      row.className = "user-row" + (isSelected ? " selected" : "");
      row.innerHTML = `
        <span class="status-dot ${isLive ? "online" : ""}"></span>
        <span class="u-name">${escapeHtml(g.name)}</span>
        <span class="u-freq">${g.member_count} أعضاء</span>
      `;
      row.addEventListener("click", () => selectChat("group", g.id));
      groupsListEl.appendChild(row);
    }
  }

  // -----------------------------------------------------------------------
  // نافذة إنشاء مجموعة
  // -----------------------------------------------------------------------

  el("new-group-btn").addEventListener("click", () => {
    newGroupError.textContent = "";
    newGroupNameInput.value = "";
    newGroupMembersEl.innerHTML = "";

    if (state.users.size === 0) {
      newGroupMembersEl.innerHTML = `<div class="member-checklist-empty">لا يوجد مستخدمون آخرون لإضافتهم</div>`;
    } else {
      for (const u of state.users.values()) {
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${u.id}" /> ${escapeHtml(u.username)}`;
        newGroupMembersEl.appendChild(label);
      }
    }
    newGroupModal.classList.remove("hidden");
  });

  el("new-group-cancel-btn").addEventListener("click", () => newGroupModal.classList.add("hidden"));

  el("new-group-create-btn").addEventListener("click", async () => {
    const name = newGroupNameInput.value.trim();
    if (!name) {
      newGroupError.textContent = "اكتب اسمًا للمجموعة";
      return;
    }
    const memberIds = [...newGroupMembersEl.querySelectorAll("input[type=checkbox]:checked")]
      .map((cb) => Number(cb.value));

    try {
      await api("/api/groups", { method: "POST", body: { name, member_ids: memberIds } });
      newGroupModal.classList.add("hidden");
      await refreshGroups();
    } catch (err) {
      newGroupError.textContent = err.message;
    }
  });

  // -----------------------------------------------------------------------
  // اختيار محادثة (مستخدم أو مجموعة) وعرض السجل
  // -----------------------------------------------------------------------

  async function selectChat(type, id) {
    state.selectedChat = { type, id };
    renderUsersList();
    renderGroupsList();

    noChatSelected.classList.add("hidden");
    chatActive.classList.remove("hidden");
    appScreen.classList.add("chat-open");

    if (type === "user") {
      const user = state.users.get(id);
      peerUsernameEl.textContent = user ? user.username : "--";
      peerStatusDot.classList.remove("hidden");
      peerStatusDot.classList.toggle("online", user && user.status === "online");
      peerSubtitleEl.classList.add("hidden");
      callBtn.textContent = "📞";
      callBtn.title = "مكالمة صوتية";
    } else {
      const group = state.groups.get(id);
      peerUsernameEl.textContent = group ? group.name : "--";
      peerStatusDot.classList.add("hidden");
      peerSubtitleEl.classList.remove("hidden");
      peerSubtitleEl.textContent = group ? `${group.member_count} أعضاء` : "";
      callBtn.textContent = "🎙️";
      callBtn.title = "مكالمة جماعية";
    }

    messagesEl.innerHTML = "<p style='color:var(--text-dim);text-align:center;font-size:13px;'>جارٍ التحميل...</p>";
    try {
      const history = type === "user"
        ? await api(`/api/messages/${id}`)
        : await api(`/api/groups/${id}/messages`);
      renderMessages(history, type);
    } catch (err) {
      showToast(err.message);
    }
  }

  el("back-to-list-btn").addEventListener("click", () => {
    appScreen.classList.remove("chat-open");
  });

  function renderMessages(history, type) {
    messagesEl.innerHTML = "";
    for (const m of history) appendMessageBubble(m, type);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessageBubble(m, type) {
    const mine = m.sender_id === state.userId;
    const row = document.createElement("div");
    row.className = "msg-row " + (mine ? "mine" : "theirs");

    let senderLabel = "";
    if (type === "group" && !mine) {
      const sender = state.users.get(m.sender_id);
      senderLabel = `<div style="font-size:11px;color:var(--accent);margin-bottom:2px;">${escapeHtml(sender ? sender.username : "مستخدم")}</div>`;
    }

    row.innerHTML = `
      <div class="bubble">
        ${senderLabel}
        ${escapeHtml(m.message)}
        <span class="time">${formatTime(m.timestamp)}</span>
      </div>
    `;
    messagesEl.appendChild(row);
  }

  messageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text || !state.selectedChat) return;

    if (state.selectedChat.type === "user") {
      sendWs({ type: "chat_message", to: state.selectedChat.id, message: text });
    } else {
      sendWs({ type: "group_message", group_id: state.selectedChat.id, message: text });
    }
    messageInput.value = "";
  });

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => showToast("متصل بالسيرفر");

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      handleWsMessage(data);
    };

    ws.onclose = () => {
      state.wsReconnectTimer = setTimeout(() => {
        if (state.token) connectWebSocket();
      }, 2000);
    };

    ws.onerror = () => ws.close();
  }

  function sendWs(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    } else {
      showToast("لا يوجد اتصال بالسيرفر حاليًا");
    }
  }

  function handleWsMessage(data) {
    switch (data.type) {
      case "user_status": return handleUserStatus(data);
      case "chat_message": return handleChatMessage(data);
      case "group_message": return handleGroupMessage(data);

      case "call_offer": return handleCallOffer(data);
      case "call_answer": return handleCallAnswer(data);
      case "ice_candidate": return handleRemoteIceCandidate(data);
      case "call_id": state.activeCallId = data.call_id; return;
      case "call_reject": return handleCallRejected(data);
      case "call_end": return handleRemoteCallEnd(data);
      case "call_error":
        showToast("المستخدم غير متصل الآن");
        endCallLocally();
        return;

      case "group_call_incoming": return handleGroupCallIncoming(data);
      case "group_call_roster": return handleGroupCallRoster(data);
      case "group_call_participant_joined": return handleGroupParticipantJoined(data);
      case "group_call_participant_left": return handleGroupParticipantLeft(data);

      default: return;
    }
  }

  function handleUserStatus(data) {
    const existing = state.users.get(data.user_id);
    if (existing) existing.status = data.status;
    else state.users.set(data.user_id, { id: data.user_id, username: data.username, status: data.status });
    renderUsersList();

    if (state.selectedChat && state.selectedChat.type === "user" && state.selectedChat.id === data.user_id) {
      peerStatusDot.classList.toggle("online", data.status === "online");
    }
  }

  function handleChatMessage(data) {
    const otherPartyId = data.from === state.userId ? data.to : data.from;
    const isOpen = state.selectedChat && state.selectedChat.type === "user" && state.selectedChat.id === otherPartyId;

    if (isOpen) {
      appendMessageBubble({ sender_id: data.from, message: data.message, timestamp: data.timestamp }, "user");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (data.from !== state.userId) {
      const sender = state.users.get(data.from);
      showToast(`رسالة جديدة من ${sender ? sender.username : "مستخدم"}`);
    }
  }

  function handleGroupMessage(data) {
    const isOpen = state.selectedChat && state.selectedChat.type === "group" && state.selectedChat.id === data.group_id;
    if (isOpen) {
      appendMessageBubble({ sender_id: data.from, message: data.message, timestamp: data.timestamp }, "group");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (data.from !== state.userId) {
      const group = state.groups.get(data.group_id);
      showToast(`رسالة جديدة في ${group ? group.name : "مجموعة"}`);
    }
  }

  // -----------------------------------------------------------------------
  // ميكروفون مشترك (يُستخدم للمكالمة الثنائية والجماعية)
  // -----------------------------------------------------------------------

  async function getMic() {
    if (state.localStream) return state.localStream;
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return state.localStream;
  }

  function addRemoteAudio(peerId, stream) {
    removeRemoteAudio(peerId);
    const audio = document.createElement("audio");
    audio.dataset.peer = String(peerId);
    audio.autoplay = true;
    audio.srcObject = stream;
    remoteAudiosContainer.appendChild(audio);
  }

  function removeRemoteAudio(peerId) {
    const existing = remoteAudiosContainer.querySelector(`audio[data-peer="${peerId}"]`);
    if (existing) existing.remove();
  }

  // -----------------------------------------------------------------------
  // مكالمة ثنائية (1:1)
  // -----------------------------------------------------------------------

  callBtn.addEventListener("click", () => {
    if (!state.selectedChat) return;
    if (state.selectedChat.type === "user") startCall(state.selectedChat.id);
    else startGroupCall(state.selectedChat.id);
  });

  function createPeerConnection(remoteUserId, { group_id = null } = {}) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: "ice_candidate", to: remoteUserId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      addRemoteAudio(remoteUserId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        if (group_id) {
          state.groupPeerConnections.delete(remoteUserId);
          removeRemoteAudio(remoteUserId);
        } else if (state.activeCallPeerId === remoteUserId) {
          callStatusTextEl.textContent = "انتهت المكالمة";
          setTimeout(() => closeCallOverlay(), 1200);
        }
      }
    };

    return pc;
  }

  async function startCall(peerId) {
    if (state.activeGroupCall) {
      showToast("أنهِ المكالمة الجماعية أولًا");
      return;
    }
    const peer = state.users.get(peerId);
    if (!peer || peer.status !== "online") {
      showToast("المستخدم غير متصل حاليًا");
      return;
    }

    state.activeCallPeerId = peerId;
    openCallOverlay(peer.username, "جارٍ الاتصال...");
    callAcceptBtn.classList.add("hidden");
    callRejectBtn.classList.add("hidden");
    callEndBtn.classList.remove("hidden");

    try {
      const stream = await getMic();
      const pc = createPeerConnection(peerId);
      state.pc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWs({ type: "call_offer", to: peerId, sdp: offer });
    } catch (err) {
      showToast("تعذّر الوصول للميكروفون: " + err.message);
      closeCallOverlay();
    }
  }

  function handleCallOffer(data) {
    // عرض ضمن مكالمة جماعية: نقبله تلقائيًا بدون واجهة رنين (المستخدم وافق مسبقًا بالانضمام)
    if (data.group_id || state.activeGroupCall) {
      handleGroupMeshOffer(data);
      return;
    }

    if (state.activeCallPeerId) {
      sendWs({ type: "call_reject", to: data.from });
      return;
    }

    state.activeCallPeerId = data.from;
    state.pendingOffer = data.sdp;

    openCallOverlay(data.from_username, "مكالمة واردة...");
    callAcceptBtn.classList.remove("hidden");
    callRejectBtn.classList.remove("hidden");
    callEndBtn.classList.add("hidden");
  }

  callAcceptBtn.addEventListener("click", async () => {
    const peerId = state.activeCallPeerId;
    if (!peerId) return;

    callStatusTextEl.textContent = "جارٍ الاتصال...";
    callAcceptBtn.classList.add("hidden");
    callRejectBtn.classList.add("hidden");
    callEndBtn.classList.remove("hidden");

    try {
      const stream = await getMic();
      const pc = createPeerConnection(peerId);
      state.pc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(state.pendingOffer));
      await flushPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: "call_answer", to: peerId, sdp: answer });

      callStatusTextEl.textContent = "متصل الآن";
    } catch (err) {
      showToast("تعذّر بدء المكالمة: " + err.message);
      endCall();
    }
  });

  callRejectBtn.addEventListener("click", () => {
    if (state.activeCallPeerId) sendWs({ type: "call_reject", to: state.activeCallPeerId });
    closeCallOverlay();
  });

  callEndBtn.addEventListener("click", () => endCall());

  async function handleCallAnswer(data) {
    const groupPc = state.groupPeerConnections.get(data.from);
    if (groupPc) {
      await groupPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      await flushGroupPendingCandidates(data.from);
      return;
    }
    if (!state.pc) return;
    await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates();
    callStatusTextEl.textContent = "متصل الآن";
  }

  async function handleRemoteIceCandidate(data) {
    const groupPc = state.groupPeerConnections.get(data.from);
    if (groupPc) {
      if (groupPc.remoteDescription) {
        try { await groupPc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
        catch (err) { console.warn("ICE error:", err); }
      } else {
        const list = state.groupPendingCandidates.get(data.from) || [];
        list.push(data.candidate);
        state.groupPendingCandidates.set(data.from, list);
      }
      return;
    }

    if (state.pc && state.pc.remoteDescription) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch (err) { console.warn("ICE error:", err); }
    } else {
      state.pendingRemoteCandidates.push(data.candidate);
    }
  }

  async function flushPendingCandidates() {
    for (const c of state.pendingRemoteCandidates) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (err) { console.warn("ICE error:", err); }
    }
    state.pendingRemoteCandidates = [];
  }

  async function flushGroupPendingCandidates(peerId) {
    const pc = state.groupPeerConnections.get(peerId);
    const list = state.groupPendingCandidates.get(peerId) || [];
    for (const c of list) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (err) { console.warn("ICE error:", err); }
    }
    state.groupPendingCandidates.delete(peerId);
  }

  function handleCallRejected() {
    showToast("تم رفض المكالمة");
    endCallLocally();
  }

  function handleRemoteCallEnd() {
    callStatusTextEl.textContent = "أنهى الطرف الآخر المكالمة";
    setTimeout(() => endCallLocally(), 800);
  }

  function endCall() {
    if (state.activeCallPeerId) {
      sendWs({ type: "call_end", to: state.activeCallPeerId, call_id: state.activeCallId });
    }
    endCallLocally();
  }

  function endCallLocally() {
    if (state.pc) { state.pc.close(); state.pc = null; }
    if (state.activeCallPeerId) removeRemoteAudio(state.activeCallPeerId);
    if (state.localStream && !state.activeGroupCall) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }
    state.activeCallPeerId = null;
    state.activeCallId = null;
    state.pendingRemoteCandidates = [];
    state.pendingOffer = null;
    closeCallOverlay();
  }

  function openCallOverlay(peerName, statusText) {
    callPeerNameEl.textContent = peerName;
    callStatusTextEl.textContent = statusText;
    callOverlay.classList.remove("hidden");
  }

  function closeCallOverlay() {
    callOverlay.classList.add("hidden");
  }

  // -----------------------------------------------------------------------
  // مكالمة جماعية (Mesh WebRTC)
  // -----------------------------------------------------------------------

  async function startGroupCall(groupId) {
    if (state.activeCallPeerId) {
      showToast("أنهِ المكالمة الثنائية أولًا");
      return;
    }
    // إعلام كل أعضاء المجموعة (دعوة/رنين)، ثم الانضمام فعليًا كمُبادر
    sendWs({ type: "group_call_invite", group_id: groupId });
    await joinGroupCall(groupId);
  }

  async function joinGroupCall(groupId) {
    if (state.activeGroupCall) {
      if (state.activeGroupCall.groupId === groupId) return; // بالفعل بنفس المكالمة
      showToast("أنهِ المكالمة الجماعية الحالية أولًا");
      return;
    }
    if (state.activeCallPeerId) {
      showToast("أنهِ المكالمة الثنائية أولًا");
      return;
    }

    try {
      await getMic();
    } catch (err) {
      showToast("تعذّر الوصول للميكروفون: " + err.message);
      return;
    }

    state.activeGroupCall = { groupId, callId: null };
    state.groupParticipants.clear();
    state.groupParticipants.set(state.userId, state.username);

    groupInviteBanner.classList.add("hidden");
    updateGroupCallBar();
    sendWs({ type: "group_call_join", group_id: groupId });
  }

  async function handleGroupCallRoster(data) {
    if (!state.activeGroupCall || state.activeGroupCall.groupId !== data.group_id) return;
    state.activeGroupCall.callId = data.call_id;

    // أنا المنضم الجديد: أفتح اتصالًا مباشرًا مع كل مشارك موجود مسبقًا
    for (const p of data.participants) {
      state.groupParticipants.set(p.id, p.username);
      await connectToGroupPeer(p.id);
    }
    updateGroupCallBar();
  }

  async function connectToGroupPeer(peerId) {
    if (state.groupPeerConnections.has(peerId)) return;
    const pc = createPeerConnection(peerId, { group_id: state.activeGroupCall.groupId });
    state.groupPeerConnections.set(peerId, pc);

    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: "call_offer", to: peerId, sdp: offer, group_id: state.activeGroupCall.groupId });
  }

  async function handleGroupMeshOffer(data) {
    // عرض وارد من مشارك (جديد انضم بعدنا، أو أثناء إعداد الاتصال المتبادل)
    const groupId = data.group_id || (state.activeGroupCall && state.activeGroupCall.groupId);
    if (!state.activeGroupCall || state.activeGroupCall.groupId !== groupId) return;

    let pc = state.groupPeerConnections.get(data.from);
    if (!pc) {
      pc = createPeerConnection(data.from, { group_id: groupId });
      state.groupPeerConnections.set(data.from, pc);
      state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
    }

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushGroupPendingCandidates(data.from);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: "call_answer", to: data.from, sdp: answer });

    state.groupParticipants.set(data.from, data.from_username || state.groupParticipants.get(data.from) || "مستخدم");
    updateGroupCallBar();
  }

  function handleGroupCallIncoming(data) {
    if (state.activeGroupCall || state.activeCallPeerId) return; // مشغول بمكالمة أخرى

    groupInviteText.textContent = `${data.from_username} بدأ مكالمة جماعية`;
    groupInviteBanner.dataset.groupId = String(data.group_id);
    groupInviteBanner.classList.remove("hidden");

    clearTimeout(groupInviteBanner._timer);
    groupInviteBanner._timer = setTimeout(() => groupInviteBanner.classList.add("hidden"), 20000);
  }

  groupInviteJoinBtn.addEventListener("click", () => {
    const groupId = Number(groupInviteBanner.dataset.groupId);
    groupInviteBanner.classList.add("hidden");
    if (groupId) joinGroupCall(groupId);
  });

  groupInviteDismissBtn.addEventListener("click", () => {
    groupInviteBanner.classList.add("hidden");
  });

  function handleGroupParticipantJoined(data) {
    if (!state.activeGroupCall || state.activeGroupCall.groupId !== data.group_id) return;
    state.groupParticipants.set(data.user_id, data.username);
    updateGroupCallBar();
    // الاتصال الفعلي (RTCPeerConnection) سيصل تلقائيًا عبر call_offer من المنضم الجديد
  }

  function handleGroupParticipantLeft(data) {
    const pc = state.groupPeerConnections.get(data.user_id);
    if (pc) { pc.close(); state.groupPeerConnections.delete(data.user_id); }
    removeRemoteAudio(data.user_id);
    state.groupParticipants.delete(data.user_id);

    if (state.activeGroupCall && state.activeGroupCall.groupId === data.group_id) {
      updateGroupCallBar();
    }
  }

  gcbLeaveBtn.addEventListener("click", () => leaveGroupCall());

  gcbMuteBtn.addEventListener("click", () => {
    if (!state.localStream) return;
    state.micMuted = !state.micMuted;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.micMuted));
    gcbMuteBtn.textContent = state.micMuted ? "إلغاء الكتم" : "كتم";
  });

  function leaveGroupCall() {
    if (state.activeGroupCall) {
      sendWs({ type: "group_call_leave", group_id: state.activeGroupCall.groupId });
    }
    leaveGroupCallLocally();
  }

  function leaveGroupCallLocally() {
    for (const [, pc] of state.groupPeerConnections) pc.close();
    state.groupPeerConnections.clear();
    state.groupPendingCandidates.clear();
    state.groupParticipants.clear();
    remoteAudiosContainer.innerHTML = "";

    if (state.localStream && !state.activeCallPeerId) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }

    state.activeGroupCall = null;
    state.micMuted = false;
    gcbMuteBtn.textContent = "كتم";
    updateGroupCallBar();
    renderGroupsList();
  }

  function updateGroupCallBar() {
    if (!state.activeGroupCall) {
      groupCallBar.classList.add("hidden");
      appScreen.classList.remove("has-group-call");
      return;
    }
    const group = state.groups.get(state.activeGroupCall.groupId);
    gcbTitle.textContent = `مكالمة جماعية: ${group ? group.name : ""}`;
    const names = [...state.groupParticipants.values()];
    gcbParticipants.textContent = `${names.length} مشاركين — ${names.join("، ")}`;
    groupCallBar.classList.remove("hidden");
    appScreen.classList.add("has-group-call");
    renderGroupsList();
  }

  // -----------------------------------------------------------------------
  // نقطة البداية
  // -----------------------------------------------------------------------

  if (state.token && state.userId) {
    enterApp();
  }
})();
