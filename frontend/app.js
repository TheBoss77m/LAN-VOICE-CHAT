/* =========================================================================
   LAN Voice & Video Chat — Frontend Core Logic
   --------------------------------------------
   - Strict Call State Machine (IDLE -> CALLING/RINGING -> CONNECTED -> ENDED)
   - WebRTC P2P Video & Voice Calling via Local LAN
   - Camera Toggle (Audio continues) & Mic Mute (Video continues)
   - Dual Theme (Dark Obsidian / Crisp Light) with Persistence
   - Comprehensive Permission & Network Error Handling
   - Group Call Mesh Audio Preserved
   ========================================================================= */

(() => {
  "use strict";

  // -----------------------------------------------------------------------
  // آلة حالات المكالمة (Call State Machine)
  // -----------------------------------------------------------------------
  const CallState = {
    IDLE: "IDLE",
    CALLING: "CALLING",
    RINGING: "RINGING",
    ACCEPTED: "ACCEPTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    REJECTED: "REJECTED",
    BUSY: "BUSY",
    FAILED: "FAILED",
    ENDING: "ENDING",
    ENDED: "ENDED",
  };

  // -----------------------------------------------------------------------
  // الحالة العامة للتطبيق
  // -----------------------------------------------------------------------
  const state = {
    token: localStorage.getItem("lvc_token") || null,
    userId: localStorage.getItem("lvc_user_id") ? Number(localStorage.getItem("lvc_user_id")) : null,
    username: localStorage.getItem("lvc_username") || null,
    theme: localStorage.getItem("lvc_theme") || "dark",

    ws: null,
    wsReconnectTimer: null,

    users: new Map(),   // id -> {id, username, status, last_seen}
    groups: new Map(),  // id -> {id, name, created_by, member_count}
    selectedChat: null, // {type: "user"|"group", id}

    // ---- حالة المكالمة الثنائية (1:1 Call) ----
    callState: CallState.IDLE,
    callType: "voice", // "voice" | "video"
    activeCallPeerId: null,
    activeCallId: null,
    pc: null,
    localStream: null,
    remoteStream: null,
    pendingOffer: null,
    pendingCandidates: [],
    callTimerInterval: null,
    callSeconds: 0,

    cameraEnabled: true,
    micMuted: false,
    speakerMuted: false,

    // ---- حالة المكالمة الجماعية (Mesh Call) ----
    activeGroupCall: null, // {groupId, callId}
    groupPeerConnections: new Map(),
    groupPendingCandidates: new Map(),
    groupParticipants: new Map(),
    groupMicMuted: false,
  };

  const RTC_CONFIG = { iceServers: [] }; // اتصال محلي مباشر P2P داخل LAN بدون خوادم STUN خارجية

  // -----------------------------------------------------------------------
  // مراجع عناصر واجهة المستخدم (DOM References)
  // -----------------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  // شاشات
  const authScreen = el("auth-screen");
  const appScreen = el("app-screen");
  const loginForm = el("login-form");
  const registerForm = el("register-form");
  const loginError = el("login-error");
  const registerError = el("register-error");

  // الشريط العلوي
  const themeToggleBtn = el("theme-toggle-btn");
  const themeIcon = el("theme-icon");
  const meUsernameEl = el("me-username");
  const meAvatarLetter = el("me-avatar-letter");
  const logoutBtn = el("logout-btn");
  const onlineUsersCount = el("online-users-count");

  // القائمة الجانبية
  const usersListEl = el("users-list");
  const groupsListEl = el("groups-list");
  const newGroupBtn = el("new-group-btn");

  // منطقة الدردشة
  const noChatSelected = el("no-chat-selected");
  const chatActive = el("chat-active");
  const backToListBtn = el("back-to-list-btn");
  const peerAvatar = el("peer-avatar");
  const peerUsernameEl = el("peer-username");
  const peerStatusDot = el("peer-status-dot");
  const peerSubtitleEl = el("peer-subtitle");
  const voiceCallBtn = el("voice-call-btn");
  const videoCallBtn = el("video-call-btn");
  const messagesEl = el("messages");
  const messageForm = el("message-form");
  const messageInput = el("message-input");

  // واجهة المكالمة الكبرى (Call Stage)
  const callStageContainer = el("call-stage-container");
  const callTypeBadge = el("call-type-badge");
  const stagePeerName = el("stage-peer-name");
  const callQualityBadge = el("call-quality-badge");
  const callDuration = el("call-duration");

  const remoteVideo = el("remote-video");
  const remoteAudioPlaceholder = el("remote-audio-placeholder");
  const remoteAvatarLetter = el("remote-avatar-letter");
  const remotePlaceholderName = el("remote-placeholder-name");
  const remoteMediaStatus = el("remote-media-status");

  const localPipCard = el("local-pip-card");
  const localVideo = el("local-video");
  const localCamOffPlaceholder = el("local-cam-off-placeholder");
  const peerStatusToast = el("peer-status-toast");

  const ctrlMicBtn = el("ctrl-mic-btn");
  const ctrlMicIcon = el("ctrl-mic-icon");
  const ctrlCamBtn = el("ctrl-cam-btn");
  const ctrlCamIcon = el("ctrl-cam-icon");
  const ctrlSpeakerBtn = el("ctrl-speaker-btn");
  const ctrlSpeakerIcon = el("ctrl-speaker-icon");
  const ctrlFullscreenBtn = el("ctrl-fullscreen-btn");
  const ctrlHangupBtn = el("ctrl-hangup-btn");

  // نافذة الرنين (Incoming)
  const incomingCallModal = el("incoming-call-modal");
  const incomingAvatarLetter = el("incoming-avatar-letter");
  const incomingCallerName = el("incoming-caller-name");
  const incomingCallTypeText = el("incoming-call-type-text");
  const acceptBtnIcon = el("accept-btn-icon");
  const incomingAcceptBtn = el("incoming-accept-btn");
  const incomingRejectBtn = el("incoming-reject-btn");

  // نافذة الاتصال الخارجي (Outgoing)
  const outgoingCallModal = el("outgoing-call-modal");
  const outgoingAvatarLetter = el("outgoing-avatar-letter");
  const outgoingPeerName = el("outgoing-peer-name");
  const outgoingStatusText = el("outgoing-status-text");
  const outgoingCancelBtn = el("outgoing-cancel-btn");

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
  const newGroupCreateBtn = el("new-group-create-btn");
  const newGroupCancelBtn = el("new-group-cancel-btn");
  const newGroupError = el("new-group-error");

  const remoteAudiosContainer = el("remote-audios-container");
  const toastEl = el("toast");

  // -----------------------------------------------------------------------
  // إدارة الوضع الليلي / النهاري (Dark / Light Theme)
  // -----------------------------------------------------------------------

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("lvc_theme", theme);
    if (themeIcon) {
      themeIcon.textContent = theme === "light" ? "☀️" : "🌙";
    }
  }

  themeToggleBtn.addEventListener("click", () => {
    const nextTheme = state.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
  });

  applyTheme(state.theme);

  // -----------------------------------------------------------------------
  // التنبيهات والأدوات المساعدة (Helpers)
  // -----------------------------------------------------------------------

  function showToast(message, ms = 3200) {
    toastEl.textContent = message;
    toastEl.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  function showPeerToast(message, ms = 2500) {
    peerStatusToast.textContent = message;
    peerStatusToast.classList.remove("hidden");
    clearTimeout(showPeerToast._t);
    showPeerToast._t = setTimeout(() => peerStatusToast.classList.add("hidden"), ms);
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
    d.textContent = str || "";
    return d.innerHTML;
  }

  // -----------------------------------------------------------------------
  // التبديل بين شاشات المصادقة (Auth Tabs)
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

  function onAuthSuccess(data) {
    state.token = data.token;
    state.userId = data.user_id;
    state.username = data.username;
    localStorage.setItem("lvc_token", data.token);
    localStorage.setItem("lvc_user_id", String(data.user_id));
    localStorage.setItem("lvc_username", data.username);
    enterApp();
  }

  logoutBtn.addEventListener("click", () => logout(true));

  async function logout(notifyServer = true) {
    if (notifyServer && state.token) {
      api("/api/logout", { method: "POST" }).catch(() => {});
    }
    if (state.callState !== CallState.IDLE) {
      endCallLocally();
    }
    if (state.activeGroupCall) {
      leaveGroupCallLocally();
    }
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }

    state.token = null;
    state.userId = null;
    state.username = null;
    localStorage.removeItem("lvc_token");
    localStorage.removeItem("lvc_user_id");
    localStorage.removeItem("lvc_username");

    appScreen.classList.add("hidden");
    authScreen.classList.remove("hidden");
  }

  // -----------------------------------------------------------------------
  // بدء التطبيق بعد تسجيل الدخول (Enter App)
  // -----------------------------------------------------------------------

  async function enterApp() {
    authScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");

    meUsernameEl.textContent = state.username;
    if (meAvatarLetter) {
      meAvatarLetter.textContent = (state.username || "U")[0].toUpperCase();
    }

    connectWebSocket();
    await loadInitialData();
  }

  async function loadInitialData() {
    try {
      const [users, groups] = await Promise.all([
        api("/api/users"),
        api("/api/groups"),
      ]);

      state.users.clear();
      for (const u of users) state.users.set(u.id, u);
      renderUsersList();

      state.groups.clear();
      for (const g of groups) state.groups.set(g.id, g);
      renderGroupsList();
    } catch (err) {
      showToast("خطأ أثناء تحميل البيانات: " + err.message);
    }
  }

  // -----------------------------------------------------------------------
  // الاتصال عبر WebSocket والإشارات (Signaling)
  // -----------------------------------------------------------------------

  function connectWebSocket() {
    if (!state.token) return;
    clearTimeout(state.wsReconnectTimer);

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => showToast("متصل بشبكة الاتصال المحلية (LAN)");

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      handleWsMessage(data);
    };

    ws.onclose = () => {
      state.wsReconnectTimer = setTimeout(() => {
        if (state.token) connectWebSocket();
      }, 2500);
    };

    ws.onerror = () => ws.close();
  }

  function sendWs(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    } else {
      showToast("لا يوجد اتصال بالشبكة حالياً");
    }
  }

  function handleWsMessage(data) {
    switch (data.type) {
      case "user_status": return handleUserStatus(data);
      case "chat_message": return handleChatMessage(data);
      case "group_message": return handleGroupMessage(data);

      // مكالمات ثنائية
      case "call_offer": return handleCallOffer(data);
      case "call_answer": return handleCallAnswer(data);
      case "ice_candidate": return handleRemoteIceCandidate(data);
      case "call_id": state.activeCallId = data.call_id; return;
      case "call_reject": return handleCallRejected(data);
      case "call_busy": return handleCallBusy(data);
      case "call_end": return handleRemoteCallEnd(data);
      case "call_error": return handleCallError(data);
      case "media_state": return handleRemoteMediaState(data);

      // مكالمات جماعية
      case "group_call_incoming": return handleGroupCallIncoming(data);
      case "group_call_roster": return handleGroupCallRoster(data);
      case "group_call_participant_joined": return handleGroupParticipantJoined(data);
      case "group_call_participant_left": return handleGroupParticipantLeft(data);

      default: return;
    }
  }

  function handleUserStatus(data) {
    const existing = state.users.get(data.user_id);
    if (existing) {
      existing.status = data.status;
    } else {
      state.users.set(data.user_id, { id: data.user_id, username: data.username, status: data.status });
    }
    renderUsersList();

    if (state.selectedChat && state.selectedChat.type === "user" && state.selectedChat.id === data.user_id) {
      peerStatusDot.classList.toggle("online", data.status === "online");
      peerSubtitleEl.textContent = data.status === "online" ? "متصل الآن بالشبكة" : "غير متصل";
    }
  }

  // -----------------------------------------------------------------------
  // الرسائل النصية
  // -----------------------------------------------------------------------

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

  function appendMessageBubble(msg, chatType) {
    const isMine = msg.sender_id === state.userId;
    const div = document.createElement("div");
    div.className = `msg-bubble ${isMine ? "mine" : "theirs"}`;

    let senderPrefix = "";
    if (chatType === "group" && !isMine) {
      const u = state.users.get(msg.sender_id);
      senderPrefix = `<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px;">${escapeHtml(u ? u.username : "عضو")}</div>`;
    }

    div.innerHTML = `
      ${senderPrefix}
      <div>${escapeHtml(msg.message)}</div>
      <div class="msg-time">${formatTime(msg.timestamp)}</div>
    `;
    messagesEl.appendChild(div);
  }

  // -----------------------------------------------------------------------
  // قائمة الأجهزة والمستخدمين (Sidebar Rendering)
  // -----------------------------------------------------------------------

  function renderUsersList() {
    usersListEl.innerHTML = "";
    const users = [...state.users.values()].filter((u) => u.id !== state.userId);

    // عداد الأجهزة المتصلة
    const onlineCount = users.filter((u) => u.status === "online").length;
    if (onlineUsersCount) onlineUsersCount.textContent = String(onlineCount);

    if (users.length === 0) {
      usersListEl.innerHTML = '<div class="list-placeholder">لا توجد أجهزة أخرى على الشبكة حالياً</div>';
      return;
    }

    // فرز: المتصلون أولاً
    users.sort((a, b) => {
      if (a.status === "online" && b.status !== "online") return -1;
      if (a.status !== "online" && b.status === "online") return 1;
      return a.username.localeCompare(b.username);
    });

    users.forEach((u) => {
      const isOnline = u.status === "online";
      const isSelected = state.selectedChat && state.selectedChat.type === "user" && state.selectedChat.id === u.id;

      const item = document.createElement("div");
      item.className = `user-item ${isSelected ? "active" : ""}`;

      item.innerHTML = `
        <div class="user-meta-left">
          <div class="user-avatar-wrap">
            <div class="user-avatar">${u.username[0].toUpperCase()}</div>
            <span class="status-dot ${isOnline ? "online" : ""}"></span>
          </div>
          <div class="user-details">
            <span class="user-name">${escapeHtml(u.username)}</span>
            <span class="user-sub">${isOnline ? "متصل بالشبكة" : "غير متصل"}</span>
          </div>
        </div>
        <div class="user-quick-actions">
          <button type="button" class="btn-quick-call" title="مكالمة صوتية" data-user-id="${u.id}">📞</button>
          <button type="button" class="btn-quick-video" title="مكالمة فيديو" data-user-id="${u.id}">🎥</button>
        </div>
      `;

      // النقر على البطاقة لفتح المحادثة
      item.addEventListener("click", (e) => {
        if (e.target.closest(".btn-quick-call") || e.target.closest(".btn-quick-video")) return;
        selectChat("user", u.id);
      });

      // زر الاتصال الصوتي السريع
      const quickCallBtn = item.querySelector(".btn-quick-call");
      quickCallBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectChat("user", u.id);
        start1on1Call(u.id, "voice");
      });

      // زر اتصال الفيديو السريع
      const quickVideoBtn = item.querySelector(".btn-quick-video");
      quickVideoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectChat("user", u.id);
        start1on1Call(u.id, "video");
      });

      usersListEl.appendChild(item);
    });
  }

  function renderGroupsList() {
    groupsListEl.innerHTML = "";
    const groups = [...state.groups.values()];

    if (groups.length === 0) {
      groupsListEl.innerHTML = '<div class="list-placeholder">لا توجد مجموعات بعد</div>';
      return;
    }

    groups.forEach((g) => {
      const isSelected = state.selectedChat && state.selectedChat.type === "group" && state.selectedChat.id === g.id;
      const isCallActive = state.activeGroupCall && state.activeGroupCall.groupId === g.id;

      const item = document.createElement("div");
      item.className = `user-item ${isSelected ? "active" : ""}`;
      item.innerHTML = `
        <div class="user-meta-left">
          <div class="user-avatar-wrap">
            <div class="user-avatar" style="background:var(--bg-raised);">👥</div>
          </div>
          <div class="user-details">
            <span class="user-name">${escapeHtml(g.name)}</span>
            <span class="user-sub">${g.member_count} أعضاء ${isCallActive ? "● مكالمة جارية" : ""}</span>
          </div>
        </div>
      `;

      item.addEventListener("click", () => selectChat("group", g.id));
      groupsListEl.appendChild(item);
    });
  }

  async function selectChat(type, id) {
    state.selectedChat = { type, id };
    renderUsersList();
    renderGroupsList();

    noChatSelected.classList.add("hidden");
    chatActive.classList.remove("hidden");
    messagesEl.innerHTML = "";

    // دعم التجاوب على الهواتف
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && window.innerWidth <= 768) {
      sidebar.classList.add("collapsed");
    }

    if (type === "user") {
      const u = state.users.get(id);
      peerUsernameEl.textContent = u ? u.username : "مستخدم";
      peerAvatar.textContent = u ? u.username[0].toUpperCase() : "👤";
      const isOnline = u && u.status === "online";
      peerStatusDot.classList.toggle("online", isOnline);
      peerSubtitleEl.textContent = isOnline ? "متصل الآن بالشبكة" : "غير متصل";

      voiceCallBtn.classList.remove("hidden");
      videoCallBtn.classList.remove("hidden");

      try {
        const history = await api(`/api/messages/${id}`);
        for (const m of history) appendMessageBubble(m, "user");
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (err) {
        showToast("تعذر جلب سجل الرسائل: " + err.message);
      }
    } else {
      const g = state.groups.get(id);
      peerUsernameEl.textContent = g ? g.name : "مجموعة";
      peerAvatar.textContent = "👥";
      peerStatusDot.classList.remove("online");
      peerSubtitleEl.textContent = `${g ? g.member_count : ""} أعضاء`;

      voiceCallBtn.classList.remove("hidden"); // مكالمة جماعية صوتية
      videoCallBtn.classList.add("hidden");

      try {
        const history = await api(`/api/groups/${id}/messages`);
        for (const m of history) appendMessageBubble(m, "group");
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } catch (err) {
        showToast("تعذر جلب سجل رسائل المجموعة: " + err.message);
      }
    }
  }

  backToListBtn.addEventListener("click", () => {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) sidebar.classList.remove("collapsed");
  });

  // -----------------------------------------------------------------------
  // الحصول على الميديا (Camera & Microphone Acquisition) مع معالجة الأخطاء
  // -----------------------------------------------------------------------

  async function getLocalMedia(callType = "voice") {
    if (state.localStream) {
      // إذا كان التدفق موجوداً مسبقاً وتطلب الآن فيديو
      if (callType === "video" && state.localStream.getVideoTracks().length === 0) {
        stopMediaStream(state.localStream);
        state.localStream = null;
      } else {
        return state.localStream;
      }
    }

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    let constraints;
    if (callType === "video") {
      constraints = {
        audio: audioConstraints,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      };
    } else {
      constraints = {
        audio: audioConstraints,
        video: false,
      };
    }

    try {
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      return state.localStream;
    } catch (err) {
      // محاولة ثانية بقيود أبسط للفيديو إذا فشلت القيود المثالية
      if (callType === "video") {
        try {
          state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          return state.localStream;
        } catch (retryErr) {
          handleMediaError(retryErr, "video");
          throw retryErr;
        }
      } else {
        handleMediaError(err, "audio");
        throw err;
      }
    }
  }

  function handleMediaError(err, type) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      showToast(
        type === "video"
          ? "تم رفض إذن الكاميرا أو الميكروفون. يرجى تفعيل الإذن من إعدادات المتصفح."
          : "تم رفض إذن الميكروفون. يرجى تفعيل الإذن للاستمرار."
      );
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      showToast(
        type === "video"
          ? "لم يتم العثور على كاميرا أو ميكروفون متصل بالجهاز."
          : "لم يتم العثور على ميكروفون متصل بالجهاز."
      );
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      showToast("الكاميرا أو الميكروفون قيد الاستخدام بواسطة تطبيق آخر.");
    } else {
      showToast("تعذر الوصول لوسائط الجهاز: " + err.message);
    }
  }

  function stopMediaStream(stream) {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
  }

  // -----------------------------------------------------------------------
  // إنشاء وإدارة RTCPeerConnection للمكالمة الثنائية (1:1 WebRTC)
  // -----------------------------------------------------------------------

  function createPeerConnection(remoteUserId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: "ice_candidate", to: remoteUserId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      state.remoteStream = stream;

      // ربط الفيديو
      remoteVideo.srcObject = stream;
      remoteVideo.classList.remove("hidden");

      // التحقق مما إذا كان هناك مسار فيديو شغال
      const hasVideo = stream.getVideoTracks().some((t) => t.enabled);
      if (hasVideo && state.callType === "video") {
        remoteAudioPlaceholder.classList.add("hidden");
      } else {
        remoteAudioPlaceholder.classList.remove("hidden");
      }

      event.track.onmute = () => {
        if (event.track.kind === "video") {
          remoteAudioPlaceholder.classList.remove("hidden");
        }
      };
      event.track.onunmute = () => {
        if (event.track.kind === "video") {
          remoteAudioPlaceholder.classList.add("hidden");
        }
      };
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          state.callState = CallState.CONNECTED;
          callQualityBadge.textContent = "متصل ممتاز";
          callQualityBadge.style.color = "var(--online)";
          startCallTimer();
          break;
        case "connecting":
          state.callState = CallState.CONNECTING;
          callQualityBadge.textContent = "جارٍ الربط...";
          break;
        case "disconnected":
          callQualityBadge.textContent = "انقطع الاتصال";
          callQualityBadge.style.color = "var(--warning)";
          showToast("انقطع الاتصال بالطرف الآخر");
          break;
        case "failed":
        case "closed":
          if (state.callState !== CallState.IDLE) {
            endCallLocally();
          }
          break;
      }
    };

    return pc;
  }

  // -----------------------------------------------------------------------
  // بدء المكالمة الثنائية (Start Call: Caller Side)
  // -----------------------------------------------------------------------

  voiceCallBtn.addEventListener("click", () => {
    if (!state.selectedChat) return;
    if (state.selectedChat.type === "user") start1on1Call(state.selectedChat.id, "voice");
    else startGroupCall(state.selectedChat.id);
  });

  videoCallBtn.addEventListener("click", () => {
    if (!state.selectedChat || state.selectedChat.type !== "user") return;
    start1on1Call(state.selectedChat.id, "video");
  });

  async function start1on1Call(peerId, callType = "voice") {
    if (state.callState !== CallState.IDLE) {
      showToast("أنت في مكالمة حالياً، أنهِها أولاً.");
      return;
    }
    if (state.activeGroupCall) {
      showToast("أنهِ المكالمة الجماعية الحالية أولاً.");
      return;
    }

    const peer = state.users.get(peerId);
    if (!peer || peer.status !== "online") {
      showToast("هذا المستخدم غير متصل بالشبكة حالياً.");
      return;
    }

    state.callType = callType;
    state.activeCallPeerId = peerId;
    state.callState = CallState.CALLING;

    // فتح نافذة الاتصال الخارجي
    outgoingPeerName.textContent = peer.username;
    outgoingAvatarLetter.textContent = callType === "video" ? "🎥" : "📞";
    outgoingStatusText.textContent = callType === "video" ? "جارٍ طلب مكالمة فيديو..." : "جارٍ طلب مكالمة صوتية...";
    outgoingCallModal.classList.remove("hidden");

    try {
      const stream = await getLocalMedia(callType);
      const pc = createPeerConnection(peerId);
      state.pc = pc;

      // ربط المعاينة المحلية
      if (callType === "video") {
        localVideo.srcObject = stream;
        localPipCard.classList.remove("hidden");
        localCamOffPlaceholder.classList.add("hidden");
      } else {
        localPipCard.classList.add("hidden");
      }

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendWs({
        type: "call_offer",
        to: peerId,
        sdp: offer,
        call_type: callType,
      });
    } catch (err) {
      endCallLocally();
    }
  }

  outgoingCancelBtn.addEventListener("click", () => {
    if (state.activeCallPeerId) {
      sendWs({ type: "call_reject", to: state.activeCallPeerId, reason: "cancelled" });
    }
    endCallLocally();
  });

  // -----------------------------------------------------------------------
  // استقبال المكالمة الثنائية (Incoming Call: Callee Side)
  // -----------------------------------------------------------------------

  function handleCallOffer(data) {
    if (data.group_id || state.activeGroupCall) {
      handleGroupMeshOffer(data);
      return;
    }

    // إذا كان مشغولاً بمكالمة أخرى
    if (state.callState !== CallState.IDLE) {
      sendWs({ type: "call_busy", to: data.from, reason: "user_busy" });
      return;
    }

    state.callState = CallState.RINGING;
    state.activeCallPeerId = data.from;
    state.callType = data.call_type || "voice";
    state.pendingOffer = data.sdp;
    state.activeCallId = data.call_id;

    incomingCallerName.textContent = data.from_username;
    incomingAvatarLetter.textContent = state.callType === "video" ? "🎥" : "👤";
    incomingCallTypeText.textContent = state.callType === "video" ? "مكالمة فيديو واردة عبر LAN..." : "مكالمة صوتية واردة عبر LAN...";
    acceptBtnIcon.textContent = state.callType === "video" ? "🎥" : "📞";

    incomingCallModal.classList.remove("hidden");
  }

  incomingRejectBtn.addEventListener("click", () => {
    if (state.activeCallPeerId) {
      sendWs({ type: "call_reject", to: state.activeCallPeerId });
    }
    endCallLocally();
  });

  incomingAcceptBtn.addEventListener("click", async () => {
    const peerId = state.activeCallPeerId;
    if (!peerId) return;

    incomingCallModal.classList.add("hidden");
    state.callState = CallState.ACCEPTED;

    try {
      const stream = await getLocalMedia(state.callType);
      const pc = createPeerConnection(peerId);
      state.pc = pc;

      // ربط المعاينة المحلية
      if (state.callType === "video") {
        localVideo.srcObject = stream;
        localPipCard.classList.remove("hidden");
        localCamOffPlaceholder.classList.add("hidden");
      } else {
        localPipCard.classList.add("hidden");
      }

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(state.pendingOffer));
      await flushPendingCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendWs({ type: "call_answer", to: peerId, sdp: answer });

      state.callState = CallState.CONNECTING;
      openCallStage();
    } catch (err) {
      showToast("تعذر قبول المكالمة: " + err.message);
      endCallLocally();
    }
  });

  // -----------------------------------------------------------------------
  // استكمال الاتصال بعد القبول (Answer Handling)
  // -----------------------------------------------------------------------

  async function handleCallAnswer(data) {
    if (data.group_id) {
      const groupPc = state.groupPeerConnections.get(data.from);
      if (groupPc) {
        await groupPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushGroupPendingCandidates(data.from);
      }
      return;
    }

    if (!state.pc) return;

    outgoingCallModal.classList.add("hidden");
    await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushPendingCandidates();

    state.callState = CallState.CONNECTING;
    openCallStage();
  }

  async function handleRemoteIceCandidate(data) {
    if (data.group_id) {
      const groupPc = state.groupPeerConnections.get(data.from);
      if (groupPc && groupPc.remoteDescription) {
        try { await groupPc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
      } else if (data.from) {
        const list = state.groupPendingCandidates.get(data.from) || [];
        list.push(data.candidate);
        state.groupPendingCandidates.set(data.from, list);
      }
      return;
    }

    if (state.pc && state.pc.remoteDescription) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (_) {}
    } else {
      state.pendingCandidates.push(data.candidate);
    }
  }

  async function flushPendingCandidates() {
    if (!state.pc) return;
    for (const c of state.pendingCandidates) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    state.pendingCandidates = [];
  }

  async function flushGroupPendingCandidates(peerId) {
    const pc = state.groupPeerConnections.get(peerId);
    if (!pc) return;
    const list = state.groupPendingCandidates.get(peerId) || [];
    for (const c of list) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
    state.groupPendingCandidates.delete(peerId);
  }

  // -----------------------------------------------------------------------
  // أحداث الرفض، الانشغال، وإنهاء المكالمة
  // -----------------------------------------------------------------------

  function handleCallRejected() {
    showToast("تم رفض المكالمة.");
    endCallLocally();
  }

  function handleCallBusy() {
    showToast("المستخدم مشغول بمكالمة أخرى حالياً.");
    endCallLocally();
  }

  function handleCallError(data) {
    if (data.reason === "user_offline") {
      showToast("المستخدم غير متصل بالشبكة.");
    } else if (data.reason === "already_in_call") {
      showToast("أنت بالفعل في مكالمة حالياً.");
    } else {
      showToast("حدث خطأ في المكالمة.");
    }
    endCallLocally();
  }

  function handleRemoteCallEnd() {
    showToast("أنهى الطرف الآخر المكالمة.");
    endCallLocally();
  }

  function handleRemoteMediaState(data) {
    if (!data.video_enabled) {
      remoteAudioPlaceholder.classList.remove("hidden");
      showPeerToast("أوقف الطرف الآخر الكاميرا");
    } else {
      if (state.callType === "video") {
        remoteAudioPlaceholder.classList.add("hidden");
        showPeerToast("شغّل الطرف الآخر الكاميرا");
      }
    }
    if (!data.audio_enabled) {
      showPeerToast("كتم الطرف الآخر الميكروفون");
    }
  }

  ctrlHangupBtn.addEventListener("click", () => endCall());

  function endCall() {
    if (state.activeCallPeerId) {
      sendWs({ type: "call_end", to: state.activeCallPeerId, call_id: state.activeCallId });
    }
    endCallLocally();
  }

  function endCallLocally() {
    state.callState = CallState.ENDED;
    stopCallTimer();

    if (state.pc) {
      state.pc.close();
      state.pc = null;
    }
    if (state.localStream && !state.activeGroupCall) {
      stopMediaStream(state.localStream);
      state.localStream = null;
    }

    state.activeCallPeerId = null;
    state.activeCallId = null;
    state.pendingOffer = null;
    state.pendingCandidates = [];
    state.remoteStream = null;

    // إعادة تعيين عناصر الـ DOM
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
    incomingCallModal.classList.add("hidden");
    outgoingCallModal.classList.add("hidden");
    callStageContainer.classList.add("hidden");

    state.cameraEnabled = true;
    state.micMuted = false;
    state.speakerMuted = false;
    ctrlMicBtn.classList.remove("off");
    ctrlCamBtn.classList.remove("off");
    ctrlSpeakerBtn.classList.remove("off");

    state.callState = CallState.IDLE;
  }

  // -----------------------------------------------------------------------
  // واجهة عرض المكالمة الكبرى والضوابط (Call Stage Controls)
  // -----------------------------------------------------------------------

  function openCallStage() {
    const peer = state.users.get(state.activeCallPeerId);
    stagePeerName.textContent = peer ? peer.username : "مستخدم";
    remotePlaceholderName.textContent = peer ? peer.username : "مستخدم";
    remoteAvatarLetter.textContent = peer ? peer.username[0].toUpperCase() : "👤";

    if (state.callType === "video") {
      callTypeBadge.textContent = "🎥 مكالمة فيديو";
      remoteAudioPlaceholder.classList.add("hidden");
      ctrlCamBtn.style.display = "flex";
    } else {
      callTypeBadge.textContent = "📞 مكالمة صوتية";
      remoteAudioPlaceholder.classList.remove("hidden");
      localPipCard.classList.add("hidden");
      ctrlCamBtn.style.display = "none"; // إخفاء زر الكاميرا بالمكالمة الصوتية
    }

    callStageContainer.classList.remove("hidden");
  }

  function startCallTimer() {
    clearInterval(state.callTimerInterval);
    state.callSeconds = 0;
    callDuration.textContent = "00:00";
    state.callTimerInterval = setInterval(() => {
      state.callSeconds++;
      const mins = String(Math.floor(state.callSeconds / 60)).padStart(2, "0");
      const secs = String(state.callSeconds % 60).padStart(2, "0");
      callDuration.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopCallTimer() {
    clearInterval(state.callTimerInterval);
    state.callTimerInterval = null;
    state.callSeconds = 0;
  }

  // كتم / تشغيل الميكروفون
  ctrlMicBtn.addEventListener("click", () => {
    if (!state.localStream) return;
    state.micMuted = !state.micMuted;

    state.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !state.micMuted;
    });

    ctrlMicBtn.classList.toggle("off", state.micMuted);
    ctrlMicIcon.textContent = state.micMuted ? "🔇" : "🎙️";

    if (state.activeCallPeerId) {
      sendWs({
        type: "media_state",
        to: state.activeCallPeerId,
        video_enabled: state.cameraEnabled,
        audio_enabled: !state.micMuted,
      });
    }
  });

  // تشغيل / إيقاف الكاميرا (الفيديو يتوقف والصوت يستمر بالعمل)
  ctrlCamBtn.addEventListener("click", () => {
    if (!state.localStream) return;
    state.cameraEnabled = !state.cameraEnabled;

    state.localStream.getVideoTracks().forEach((track) => {
      track.enabled = state.cameraEnabled;
    });

    ctrlCamBtn.classList.toggle("off", !state.cameraEnabled);
    ctrlCamIcon.textContent = state.cameraEnabled ? "📹" : "📷";
    localCamOffPlaceholder.classList.toggle("hidden", state.cameraEnabled);

    if (state.activeCallPeerId) {
      sendWs({
        type: "media_state",
        to: state.activeCallPeerId,
        video_enabled: state.cameraEnabled,
        audio_enabled: !state.micMuted,
      });
    }
  });

  // كتم / تشغيل مكبر الصوت
  ctrlSpeakerBtn.addEventListener("click", () => {
    state.speakerMuted = !state.speakerMuted;
    remoteVideo.muted = state.speakerMuted;

    ctrlSpeakerBtn.classList.toggle("off", state.speakerMuted);
    ctrlSpeakerIcon.textContent = state.speakerMuted ? "🔈" : "🔊";
  });

  // ملء الشاشة
  ctrlFullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      callStageContainer.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // -----------------------------------------------------------------------
  // المكالمات الجماعية (Mesh Voice Calls)
  // -----------------------------------------------------------------------

  async function startGroupCall(groupId) {
    if (state.callState !== CallState.IDLE) {
      showToast("أنهِ المكالمة الثنائية أولاً");
      return;
    }
    sendWs({ type: "group_call_invite", group_id: groupId });
    await joinGroupCall(groupId);
  }

  async function joinGroupCall(groupId) {
    if (state.activeGroupCall) {
      if (state.activeGroupCall.groupId === groupId) return;
      showToast("أنهِ المكالمة الجماعية الحالية أولاً");
      return;
    }
    if (state.callState !== CallState.IDLE) {
      showToast("أنهِ المكالمة الثنائية أولاً");
      return;
    }

    try {
      await getLocalMedia("voice");
    } catch (err) {
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

    for (const p of data.participants) {
      state.groupParticipants.set(p.id, p.username);
      await connectToGroupPeer(p.id);
    }
    updateGroupCallBar();
  }

  async function connectToGroupPeer(peerId) {
    if (state.groupPeerConnections.has(peerId)) return;
    const pc = createGroupPeerConnection(peerId, state.activeGroupCall.groupId);
    state.groupPeerConnections.set(peerId, pc);

    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({ type: "call_offer", to: peerId, sdp: offer, group_id: state.activeGroupCall.groupId });
  }

  function createGroupPeerConnection(remoteUserId, groupId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({ type: "ice_candidate", to: remoteUserId, candidate: event.candidate, group_id: groupId });
      }
    };

    pc.ontrack = (event) => {
      addRemoteAudio(remoteUserId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        state.groupPeerConnections.delete(remoteUserId);
        removeRemoteAudio(remoteUserId);
      }
    };

    return pc;
  }

  async function handleGroupMeshOffer(data) {
    const groupId = data.group_id || (state.activeGroupCall && state.activeGroupCall.groupId);
    if (!state.activeGroupCall || state.activeGroupCall.groupId !== groupId) return;

    let pc = state.groupPeerConnections.get(data.from);
    if (!pc) {
      pc = createGroupPeerConnection(data.from, groupId);
      state.groupPeerConnections.set(data.from, pc);
      state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
    }

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    await flushGroupPendingCandidates(data.from);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: "call_answer", to: data.from, sdp: answer, group_id: groupId });

    state.groupParticipants.set(data.from, data.from_username || "مستخدم");
    updateGroupCallBar();
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

  function handleGroupCallIncoming(data) {
    if (state.activeGroupCall || state.callState !== CallState.IDLE) return;

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
    state.groupMicMuted = !state.groupMicMuted;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.groupMicMuted));
    gcbMuteBtn.textContent = state.groupMicMuted ? "إلغاء الكتم" : "كتم";
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

    if (state.localStream && state.callState === CallState.IDLE) {
      stopMediaStream(state.localStream);
      state.localStream = null;
    }

    state.activeGroupCall = null;
    state.groupMicMuted = false;
    gcbMuteBtn.textContent = "كتم";
    updateGroupCallBar();
    renderGroupsList();
  }

  function updateGroupCallBar() {
    if (!state.activeGroupCall) {
      groupCallBar.classList.add("hidden");
      return;
    }
    const group = state.groups.get(state.activeGroupCall.groupId);
    gcbTitle.textContent = `مكالمة جماعية: ${group ? group.name : ""}`;
    const names = [...state.groupParticipants.values()];
    gcbParticipants.textContent = `${names.length} مشاركين — ${names.join("، ")}`;
    groupCallBar.classList.remove("hidden");
  }

  // -----------------------------------------------------------------------
  // إنشاء المجموعات (New Group Modal)
  // -----------------------------------------------------------------------

  newGroupBtn.addEventListener("click", () => {
    newGroupNameInput.value = "";
    newGroupError.textContent = "";
    newGroupMembersEl.innerHTML = "";

    const users = [...state.users.values()].filter((u) => u.id !== state.userId);
    if (users.length === 0) {
      newGroupMembersEl.innerHTML = '<p style="color:var(--text-dim);font-size:12px;">لا يوجد مستخدمون آخرون مسجلون بعد</p>';
    } else {
      users.forEach((u) => {
        const label = document.createElement("label");
        label.className = "member-check-item";
        label.innerHTML = `
          <input type="checkbox" value="${u.id}" />
          <span>${escapeHtml(u.username)}</span>
        `;
        newGroupMembersEl.appendChild(label);
      });
    }

    newGroupModal.classList.remove("hidden");
  });

  newGroupCancelBtn.addEventListener("click", () => newGroupModal.classList.add("hidden"));

  newGroupCreateBtn.addEventListener("click", async () => {
    const name = newGroupNameInput.value.trim();
    if (!name) {
      newGroupError.textContent = "اسم المجموعة مطلوب";
      return;
    }

    const memberIds = [];
    newGroupMembersEl.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => {
      memberIds.push(Number(cb.value));
    });

    try {
      const created = await api("/api/groups", {
        method: "POST",
        body: { name, member_ids: memberIds },
      });
      state.groups.set(created.id, created);
      renderGroupsList();
      newGroupModal.classList.add("hidden");
      selectChat("group", created.id);
    } catch (err) {
      newGroupError.textContent = err.message;
    }
  });

  // -----------------------------------------------------------------------
  // نقطة البداية التلقائية (Auto-login check)
  // -----------------------------------------------------------------------

  if (state.token && state.userId) {
    enterApp();
  }
})();
