/* =========================================================================
   LAN Voice & Video Chat — Client MVC Architecture (views/app.js)
   -------------------------------------------------------------------------
   [M] Models:
       - CallState: آلة حالات المكالمة الثنائية (State Machine)
       - AppModel: إدارة الحالة التفاعلية، بيانات المستخدمين، الاتصال والتخزين
   [V] Views:
       - DOM: عناصر الواجهة المحددة
       - ThemeView: تحديث السمة (Dark Obsidian / Crisp Light)
       - AuthView: تبديل شاشات وتسجيل الدخول وعرض الأخطاء
       - SidebarView: قائمة الأجهزة والمجموعات والعدادات
       - ChatView: عرض المحادثات وفقاعات الرسائل وحالة النظير
       - CallStageView: مسرح المكالمة، الفيديو البعيد، بطاقة PIP، والأزرار
       - ModalsView: نوافذ الرنين الوارد، الاتصال الصادر، وإنشاء المجموعات
       - GroupCallView: شريط المكالمة الجماعية وقائمة المشاركين
       - ToastView: الإشعارات العائمة السريعة
   [C] Controllers:
       - AuthController: معالجة الدخول والخروج والتحقق
       - ThemeController: إدارة تبديل السمة
       - ChatController: إدارة اختيار الدردشة وإرسال الرسائل
       - CallController: إدارة المكالمات الثنائية (1:1 WebRTC P2P) والوسائط
       - GroupCallController: إدارة المكالمات الجماعية (Mesh Voice Calls)
       - WebSocketController: إدارة قناة الإشارات والتوجيه التلقائي
       - AppController: منسق التطبيق، ربط الأحداث، ونقطة البداية
   ========================================================================= */

(() => {
  "use strict";

  /* =========================================================================
     [M - MODEL] نماذج البيانات وحالة التطبيق والاتصال
     ========================================================================= */

  // آلة حالات المكالمة الثنائية (Call State Machine)
  const CallState = Object.freeze({
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
  });

  const RTC_CONFIG = { iceServers: [] }; // اتصال محلي مباشر P2P داخل LAN بدون أي خوادم سحابية

  // نموذج بيانات التطبيق (AppModel)
  class AppModel {
    constructor() {
      this.token = localStorage.getItem("lvc_token") || null;
      this.userId = localStorage.getItem("lvc_user_id") ? Number(localStorage.getItem("lvc_user_id")) : null;
      this.username = localStorage.getItem("lvc_username") || null;
      this.theme = localStorage.getItem("lvc_theme") || "dark";

      this.ws = null;
      this.wsReconnectTimer = null;

      this.users = new Map();   // id -> {id, username, status, last_seen}
      this.groups = new Map();  // id -> {id, name, created_by, member_count}
      this.selectedChat = null; // {type: "user"|"group", id}

      // حالة المكالمة الثنائية (1:1 Call)
      this.callState = CallState.IDLE;
      this.callType = "voice"; // "voice" | "video"
      this.activeCallPeerId = null;
      this.activeCallId = null;
      this.pc = null;
      this.localStream = null;
      this.remoteStream = null;
      this.pendingOffer = null;
      this.pendingCandidates = [];
      this.callTimerInterval = null;
      this.callSeconds = 0;

      this.cameraEnabled = true;
      this.micMuted = false;
      this.speakerMuted = false;

      // حالة المكالمة الجماعية (Mesh Voice Call)
      this.activeGroupCall = null; // {groupId, callId}
      this.groupPeerConnections = new Map();
      this.groupPendingCandidates = new Map();
      this.groupParticipants = new Map();
      this.groupMicMuted = false;
    }

    setAuth(token, userId, username) {
      this.token = token;
      this.userId = Number(userId);
      this.username = username;
      localStorage.setItem("lvc_token", token);
      localStorage.setItem("lvc_user_id", String(userId));
      localStorage.setItem("lvc_username", username);
    }

    clearAuth() {
      this.token = null;
      this.userId = null;
      this.username = null;
      localStorage.removeItem("lvc_token");
      localStorage.removeItem("lvc_user_id");
      localStorage.removeItem("lvc_username");
    }

    setTheme(theme) {
      this.theme = theme;
      localStorage.setItem("lvc_theme", theme);
    }

    // استدعاء واجهات REST API
    async api(path, { method = "GET", body } = {}) {
      const headers = { "Content-Type": "application/json" };
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 401) {
        throw new Error("UNAUTHORIZED");
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "حدث خطأ غير متوقع");
      return data;
    }

    formatTime(isoString) {
      try {
        const d = new Date(isoString + "Z");
        return d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });
      } catch {
        return "";
      }
    }

    escapeHtml(str) {
      const d = document.createElement("div");
      d.textContent = str || "";
      return d.innerHTML;
    }
  }

  const model = new AppModel();

  /* =========================================================================
     [V - VIEW] واجهات ومكونات العرض وتحديث واجهة المستخدم (UI / DOM Views)
     ========================================================================= */

  const $ = (id) => document.getElementById(id);

  const DOM = {
    // شاشات
    authScreen: $("auth-screen"),
    appScreen: $("app-screen"),
    loginForm: $("login-form"),
    registerForm: $("register-form"),
    loginError: $("login-error"),
    registerError: $("register-error"),

    // الشريط العلوي
    themeToggleBtn: $("theme-toggle-btn"),
    themeIcon: $("theme-icon"),
    meUsername: $("me-username"),
    meAvatarLetter: $("me-avatar-letter"),
    logoutBtn: $("logout-btn"),
    onlineUsersCount: $("online-users-count"),

    // القائمة الجانبية
    sidebar: document.querySelector(".sidebar"),
    usersList: $("users-list"),
    groupsList: $("groups-list"),
    newGroupBtn: $("new-group-btn"),

    // منطقة المحادثة
    noChatSelected: $("no-chat-selected"),
    chatActive: $("chat-active"),
    backToListBtn: $("back-to-list-btn"),
    peerAvatar: $("peer-avatar"),
    peerUsername: $("peer-username"),
    peerStatusDot: $("peer-status-dot"),
    peerSubtitle: $("peer-subtitle"),
    voiceCallBtn: $("voice-call-btn"),
    videoCallBtn: $("video-call-btn"),
    messages: $("messages"),
    messageForm: $("message-form"),
    messageInput: $("message-input"),

    // مسرح المكالمة (Call Stage)
    callStageContainer: $("call-stage-container"),
    callTypeBadge: $("call-type-badge"),
    stagePeerName: $("stage-peer-name"),
    callQualityBadge: $("call-quality-badge"),
    callDuration: $("call-duration"),

    remoteVideo: $("remote-video"),
    remoteAudioPlaceholder: $("remote-audio-placeholder"),
    remoteAvatarLetter: $("remote-avatar-letter"),
    remotePlaceholderName: $("remote-placeholder-name"),
    remoteMediaStatus: $("remote-media-status"),

    localPipCard: $("local-pip-card"),
    localVideo: $("local-video"),
    localCamOffPlaceholder: $("local-cam-off-placeholder"),
    peerStatusToast: $("peer-status-toast"),

    ctrlMicBtn: $("ctrl-mic-btn"),
    ctrlMicIcon: $("ctrl-mic-icon"),
    ctrlCamBtn: $("ctrl-cam-btn"),
    ctrlCamIcon: $("ctrl-cam-icon"),
    ctrlSpeakerBtn: $("ctrl-speaker-btn"),
    ctrlSpeakerIcon: $("ctrl-speaker-icon"),
    ctrlFullscreenBtn: $("ctrl-fullscreen-btn"),
    ctrlHangupBtn: $("ctrl-hangup-btn"),

    // نوافذ المكالمات
    incomingCallModal: $("incoming-call-modal"),
    incomingAvatarLetter: $("incoming-avatar-letter"),
    incomingCallerName: $("incoming-caller-name"),
    incomingCallTypeText: $("incoming-call-type-text"),
    acceptBtnIcon: $("accept-btn-icon"),
    incomingAcceptBtn: $("incoming-accept-btn"),
    incomingRejectBtn: $("incoming-reject-btn"),

    outgoingCallModal: $("outgoing-call-modal"),
    outgoingAvatarLetter: $("outgoing-avatar-letter"),
    outgoingPeerName: $("outgoing-peer-name"),
    outgoingStatusText: $("outgoing-status-text"),
    outgoingCancelBtn: $("outgoing-cancel-btn"),

    // مكالمة جماعية
    groupCallBar: $("group-call-bar"),
    gcbTitle: $("gcb-title"),
    gcbParticipants: $("gcb-participants"),
    gcbMuteBtn: $("gcb-mute-btn"),
    gcbLeaveBtn: $("gcb-leave-btn"),
    groupInviteBanner: $("group-invite-banner"),
    groupInviteText: $("group-invite-text"),
    groupInviteJoinBtn: $("group-invite-join-btn"),
    groupInviteDismissBtn: $("group-invite-dismiss-btn"),

    // نافذة إنشاء مجموعة
    newGroupModal: $("new-group-modal"),
    newGroupNameInput: $("new-group-name"),
    newGroupMembers: $("new-group-members"),
    newGroupCreateBtn: $("new-group-create-btn"),
    newGroupCancelBtn: $("new-group-cancel-btn"),
    newGroupError: $("new-group-error"),

    remoteAudiosContainer: $("remote-audios-container"),
    toast: $("toast"),
  };

  // View: السمة
  const ThemeView = {
    render(theme) {
      document.documentElement.setAttribute("data-theme", theme);
      if (DOM.themeIcon) {
        DOM.themeIcon.textContent = theme === "light" ? "☀️" : "🌙";
      }
    },
  };

  // View: التنبيهات
  const ToastView = {
    show(message, ms = 3200) {
      DOM.toast.textContent = message;
      DOM.toast.classList.remove("hidden");
      clearTimeout(ToastView._t);
      ToastView._t = setTimeout(() => DOM.toast.classList.add("hidden"), ms);
    },
    showPeerStatus(message, ms = 2500) {
      DOM.peerStatusToast.textContent = message;
      DOM.peerStatusToast.classList.remove("hidden");
      clearTimeout(ToastView._p);
      ToastView._p = setTimeout(() => DOM.peerStatusToast.classList.add("hidden"), ms);
    },
  };

  // View: شاشات الدخول
  const AuthView = {
    switchTab(tab) {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      const activeBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      if (activeBtn) activeBtn.classList.add("active");
      DOM.loginForm.classList.toggle("hidden", tab !== "login");
      DOM.registerForm.classList.toggle("hidden", tab !== "register");
      DOM.loginError.textContent = "";
      DOM.registerError.textContent = "";
    },
    showScreen(screen) {
      if (screen === "app") {
        DOM.authScreen.classList.add("hidden");
        DOM.appScreen.classList.remove("hidden");
        DOM.meUsername.textContent = model.username || "";
        if (DOM.meAvatarLetter) {
          DOM.meAvatarLetter.textContent = (model.username || "U")[0].toUpperCase();
        }
      } else {
        DOM.appScreen.classList.add("hidden");
        DOM.authScreen.classList.remove("hidden");
      }
    },
    setLoginError(msg) { DOM.loginError.textContent = msg; },
    setRegisterError(msg) { DOM.registerError.textContent = msg; },
  };

  // View: القائمة الجانبية
  const SidebarView = {
    renderUsersList(usersMap, currentUserId, selectedChat, onSelectUser, onQuickCall) {
      DOM.usersList.innerHTML = "";
      const users = [...usersMap.values()].filter((u) => u.id !== currentUserId);

      // عداد المتصلين
      const onlineCount = users.filter((u) => u.status === "online").length;
      if (DOM.onlineUsersCount) DOM.onlineUsersCount.textContent = String(onlineCount);

      if (users.length === 0) {
        DOM.usersList.innerHTML = '<div class="list-placeholder">لا توجد أجهزة أخرى على الشبكة حالياً</div>';
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
        const isSelected = selectedChat && selectedChat.type === "user" && selectedChat.id === u.id;

        const item = document.createElement("div");
        item.className = `user-item ${isSelected ? "active" : ""}`;
        item.innerHTML = `
          <div class="user-meta-left">
            <div class="user-avatar-wrap">
              <div class="user-avatar">${u.username[0].toUpperCase()}</div>
              <span class="status-dot ${isOnline ? "online" : ""}"></span>
            </div>
            <div class="user-details">
              <span class="user-name">${model.escapeHtml(u.username)}</span>
              <span class="user-sub">${isOnline ? "متصل بالشبكة" : "غير متصل"}</span>
            </div>
          </div>
          <div class="user-quick-actions">
            <button type="button" class="btn-quick-call" title="مكالمة صوتية" data-user-id="${u.id}">📞</button>
            <button type="button" class="btn-quick-video" title="مكالمة فيديو" data-user-id="${u.id}">🎥</button>
          </div>
        `;

        item.addEventListener("click", (e) => {
          if (e.target.closest(".btn-quick-call") || e.target.closest(".btn-quick-video")) return;
          onSelectUser(u.id);
        });

        item.querySelector(".btn-quick-call").addEventListener("click", (e) => {
          e.stopPropagation();
          onQuickCall(u.id, "voice");
        });

        item.querySelector(".btn-quick-video").addEventListener("click", (e) => {
          e.stopPropagation();
          onQuickCall(u.id, "video");
        });

        DOM.usersList.appendChild(item);
      });
    },

    renderGroupsList(groupsMap, selectedChat, activeGroupCall, onSelectGroup) {
      DOM.groupsList.innerHTML = "";
      const groups = [...groupsMap.values()];

      if (groups.length === 0) {
        DOM.groupsList.innerHTML = '<div class="list-placeholder">لا توجد مجموعات بعد</div>';
        return;
      }

      groups.forEach((g) => {
        const isSelected = selectedChat && selectedChat.type === "group" && selectedChat.id === g.id;
        const isCallActive = activeGroupCall && activeGroupCall.groupId === g.id;

        const item = document.createElement("div");
        item.className = `user-item ${isSelected ? "active" : ""}`;
        item.innerHTML = `
          <div class="user-meta-left">
            <div class="user-avatar-wrap">
              <div class="user-avatar" style="background:var(--bg-raised);">👥</div>
            </div>
            <div class="user-details">
              <span class="user-name">${model.escapeHtml(g.name)}</span>
              <span class="user-sub">${g.member_count} أعضاء ${isCallActive ? "● مكالمة جارية" : ""}</span>
            </div>
          </div>
        `;

        item.addEventListener("click", () => onSelectGroup(g.id));
        DOM.groupsList.appendChild(item);
      });
    },
  };

  // View: منطقة الدردشة
  const ChatView = {
    setupChatUI(type, entity) {
      DOM.noChatSelected.classList.add("hidden");
      DOM.chatActive.classList.remove("hidden");
      DOM.messages.innerHTML = "";

      if (DOM.sidebar && window.innerWidth <= 768) {
        DOM.sidebar.classList.add("collapsed");
      }

      if (type === "user") {
        DOM.peerUsername.textContent = entity ? entity.username : "مستخدم";
        DOM.peerAvatar.textContent = entity ? entity.username[0].toUpperCase() : "👤";
        const isOnline = entity && entity.status === "online";
        DOM.peerStatusDot.classList.toggle("online", isOnline);
        DOM.peerSubtitle.textContent = isOnline ? "متصل الآن بالشبكة" : "غير متصل";
        DOM.voiceCallBtn.classList.remove("hidden");
        DOM.videoCallBtn.classList.remove("hidden");
      } else {
        DOM.peerUsername.textContent = entity ? entity.name : "مجموعة";
        DOM.peerAvatar.textContent = "👥";
        DOM.peerStatusDot.classList.remove("online");
        DOM.peerSubtitle.textContent = `${entity ? entity.member_count : ""} أعضاء`;
        DOM.voiceCallBtn.classList.remove("hidden");
        DOM.videoCallBtn.classList.add("hidden");
      }
    },

    appendBubble(msg, chatType, currentUserId, usersMap) {
      const isMine = msg.sender_id === currentUserId;
      const div = document.createElement("div");
      div.className = `msg-bubble ${isMine ? "mine" : "theirs"}`;

      let senderPrefix = "";
      if (chatType === "group" && !isMine) {
        const u = usersMap.get(msg.sender_id);
        senderPrefix = `<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px;">${model.escapeHtml(u ? u.username : "عضو")}</div>`;
      }

      div.innerHTML = `
        ${senderPrefix}
        <div>${model.escapeHtml(msg.message)}</div>
        <div class="msg-time">${model.formatTime(msg.timestamp)}</div>
      `;
      DOM.messages.appendChild(div);
    },

    scrollToBottom() {
      DOM.messages.scrollTop = DOM.messages.scrollHeight;
    },
  };

  // View: مسرح المكالمة الثنائية (Call Stage View)
  const CallStageView = {
    show(peerName, callType) {
      DOM.callStageContainer.classList.remove("hidden");
      DOM.stagePeerName.textContent = peerName;
      DOM.remotePlaceholderName.textContent = peerName;
      DOM.remoteAvatarLetter.textContent = (peerName || "U")[0].toUpperCase();

      DOM.callTypeBadge.textContent = callType === "video" ? "🎥 مكالمة فيديو" : "📞 مكالمة صوتية";
      DOM.callQualityBadge.textContent = "جارٍ التهيئة...";
      DOM.callQualityBadge.style.color = "var(--text-muted)";
      DOM.callDuration.textContent = "00:00";

      if (callType === "video") {
        DOM.remoteVideo.classList.remove("hidden");
        DOM.remoteAudioPlaceholder.classList.add("hidden");
        DOM.localPipCard.classList.remove("hidden");
        DOM.ctrlCamBtn.classList.remove("hidden");
      } else {
        DOM.remoteVideo.classList.add("hidden");
        DOM.remoteAudioPlaceholder.classList.remove("hidden");
        DOM.localPipCard.classList.add("hidden");
        DOM.ctrlCamBtn.classList.add("hidden");
      }
    },

    hide() {
      DOM.callStageContainer.classList.add("hidden");
      DOM.remoteVideo.srcObject = null;
      DOM.localVideo.srcObject = null;
      DOM.remoteMediaStatus.textContent = "";
      DOM.peerStatusToast.classList.add("hidden");
    },

    updateQuality(text, color) {
      DOM.callQualityBadge.textContent = text;
      DOM.callQualityBadge.style.color = color;
    },

    updateTimer(seconds) {
      const m = String(Math.floor(seconds / 60)).padStart(2, "0");
      const s = String(seconds % 60).padStart(2, "0");
      DOM.callDuration.textContent = `${m}:${s}`;
    },

    updateControls(micMuted, cameraEnabled, speakerMuted, callType) {
      DOM.ctrlMicBtn.classList.toggle("muted", micMuted);
      DOM.ctrlMicIcon.textContent = micMuted ? "🔇" : "🎤";

      if (callType === "video") {
        DOM.ctrlCamBtn.classList.toggle("off", !cameraEnabled);
        DOM.ctrlCamIcon.textContent = cameraEnabled ? "📹" : "🚫";
        DOM.localCamOffPlaceholder.classList.toggle("hidden", cameraEnabled);
      }

      DOM.ctrlSpeakerBtn.classList.toggle("muted", speakerMuted);
      DOM.ctrlSpeakerIcon.textContent = speakerMuted ? "🔈" : "🔊";
    },

    setRemoteMediaNotice(text) {
      DOM.remoteMediaStatus.textContent = text;
    },
  };

  // View: النوافذ المنبثقة (Modals View)
  const ModalsView = {
    showIncoming(callerName, callType) {
      DOM.incomingCallerName.textContent = callerName;
      DOM.incomingAvatarLetter.textContent = (callerName || "U")[0].toUpperCase();
      DOM.incomingCallTypeText.textContent = callType === "video" ? "مكالمة فيديو واردة..." : "مكالمة صوتية واردة...";
      DOM.acceptBtnIcon.textContent = callType === "video" ? "📹" : "📞";
      DOM.incomingCallModal.classList.remove("hidden");
    },
    hideIncoming() {
      DOM.incomingCallModal.classList.add("hidden");
    },

    showOutgoing(peerName, callType) {
      DOM.outgoingPeerName.textContent = peerName;
      DOM.outgoingAvatarLetter.textContent = (peerName || "U")[0].toUpperCase();
      DOM.outgoingStatusText.textContent = callType === "video" ? "جارٍ طلب مكالمة فيديو..." : "جارٍ الاتصال صوتياً...";
      DOM.outgoingCallModal.classList.remove("hidden");
    },
    hideOutgoing() {
      DOM.outgoingCallModal.classList.add("hidden");
    },

    showNewGroup(usersMap, currentUserId) {
      DOM.newGroupNameInput.value = "";
      DOM.newGroupError.textContent = "";
      DOM.newGroupMembers.innerHTML = "";

      const users = [...usersMap.values()].filter((u) => u.id !== currentUserId);
      if (users.length === 0) {
        DOM.newGroupMembers.innerHTML = '<p style="color:var(--text-dim);font-size:12px;">لا يوجد مستخدمون آخرون مسجلون بعد</p>';
      } else {
        users.forEach((u) => {
          const label = document.createElement("label");
          label.className = "member-check-item";
          label.innerHTML = `
            <input type="checkbox" value="${u.id}" />
            <span>${model.escapeHtml(u.username)}</span>
          `;
          DOM.newGroupMembers.appendChild(label);
        });
      }
      DOM.newGroupModal.classList.remove("hidden");
    },
    hideNewGroup() {
      DOM.newGroupModal.classList.add("hidden");
    },
  };

  // View: المكالمة الجماعية
  const GroupCallView = {
    renderBar(activeGroupCall, group, participantsMap, micMuted) {
      if (!activeGroupCall) {
        DOM.groupCallBar.classList.add("hidden");
        return;
      }
      DOM.gcbTitle.textContent = `مكالمة جماعية: ${group ? group.name : ""}`;
      const names = [...participantsMap.values()];
      DOM.gcbParticipants.textContent = `${names.length} مشاركين — ${names.join("، ")}`;
      DOM.gcbMuteBtn.textContent = micMuted ? "إلغاء الكتم" : "كتم";
      DOM.groupCallBar.classList.remove("hidden");
    },

    showInvite(groupName, onJoin, onDismiss) {
      DOM.groupInviteText.textContent = `مكالمة صوتية جارية في: ${groupName}`;
      DOM.groupInviteBanner.classList.remove("hidden");

      DOM.groupInviteJoinBtn.onclick = () => {
        DOM.groupInviteBanner.classList.add("hidden");
        onJoin();
      };
      DOM.groupInviteDismissBtn.onclick = () => {
        DOM.groupInviteBanner.classList.add("hidden");
        onDismiss();
      };
    },
  };

  /* =========================================================================
     [C - CONTROLLER] المتحكمات وإدارة منطق الأعمال والاتصالات الشبكية
     ========================================================================= */

  // Controller: السمة
  const ThemeController = {
    init() {
      ThemeView.render(model.theme);
      DOM.themeToggleBtn.addEventListener("click", () => {
        const nextTheme = model.theme === "dark" ? "light" : "dark";
        model.setTheme(nextTheme);
        ThemeView.render(nextTheme);
      });
    },
  };

  // Controller: المصادقة
  const AuthController = {
    init() {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => AuthView.switchTab(btn.dataset.tab));
      });

      DOM.loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        AuthView.setLoginError("");
        const fd = new FormData(DOM.loginForm);
        try {
          const data = await model.api("/api/login", {
            method: "POST",
            body: { username: fd.get("username"), password: fd.get("password") },
          });
          AuthController.onSuccess(data);
        } catch (err) {
          AuthView.setLoginError(err.message);
        }
      });

      DOM.registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        AuthView.setRegisterError("");
        const fd = new FormData(DOM.registerForm);
        try {
          const data = await model.api("/api/register", {
            method: "POST",
            body: { username: fd.get("username"), password: fd.get("password") },
          });
          AuthController.onSuccess(data);
        } catch (err) {
          AuthView.setRegisterError(err.message);
        }
      });

      DOM.logoutBtn.addEventListener("click", () => AuthController.logout(true));
    },

    onSuccess(data) {
      model.setAuth(data.token, data.user_id, data.username);
      AuthController.enterApp();
    },

    async enterApp() {
      AuthView.showScreen("app");
      WebSocketController.connect();
      await AppController.loadInitialData();
    },

    async logout(notifyServer = true) {
      if (notifyServer && model.token) {
        model.api("/api/logout", { method: "POST" }).catch(() => {});
      }
      if (model.callState !== CallState.IDLE) {
        CallController.endCallLocally();
      }
      if (model.activeGroupCall) {
        GroupCallController.leaveLocally();
      }
      WebSocketController.disconnect();
      model.clearAuth();
      AuthView.showScreen("auth");
    },
  };

  // Controller: قناة الإشارات (WebSocket Signaling Controller)
  const WebSocketController = {
    connect() {
      if (!model.token) return;
      clearTimeout(model.wsReconnectTimer);

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(model.token)}`;
      const ws = new WebSocket(url);
      model.ws = ws;

      ws.onopen = () => ToastView.show("متصل بشبكة الاتصال المحلية (LAN)");

      ws.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        WebSocketController.routeMessage(data);
      };

      ws.onclose = () => {
        model.wsReconnectTimer = setTimeout(() => {
          if (model.token) WebSocketController.connect();
        }, 2500);
      };

      ws.onerror = () => ws.close();
    },

    send(payload) {
      if (model.ws && model.ws.readyState === WebSocket.OPEN) {
        model.ws.send(JSON.stringify(payload));
      } else {
        ToastView.show("لا يوجد اتصال بالشبكة حالياً");
      }
    },

    disconnect() {
      if (model.ws) {
        model.ws.onclose = null;
        model.ws.close();
        model.ws = null;
      }
    },

    routeMessage(data) {
      switch (data.type) {
        case "user_status": return UserController.handleStatus(data);
        case "chat_message": return ChatController.handleIncomingDirect(data);
        case "group_message": return ChatController.handleIncomingGroup(data);

        // مكالمات ثنائية 1:1
        case "call_offer": return CallController.handleOffer(data);
        case "call_answer": return CallController.handleAnswer(data);
        case "ice_candidate": return CallController.handleRemoteCandidate(data);
        case "call_id": model.activeCallId = data.call_id; return;
        case "call_reject": return CallController.handleReject(data);
        case "call_busy": return CallController.handleBusy(data);
        case "call_end": return CallController.handleRemoteEnd(data);
        case "call_error": return CallController.handleError(data);
        case "media_state": return CallController.handleRemoteMediaState(data);

        // مكالمات جماعية Mesh
        case "group_call_incoming": return GroupCallController.handleIncoming(data);
        case "group_call_roster": return GroupCallController.handleRoster(data);
        case "group_call_participant_joined": return GroupCallController.handleParticipantJoined(data);
        case "group_call_participant_left": return GroupCallController.handleParticipantLeft(data);

        default: return;
      }
    },
  };

  // Controller: المستخدمين
  const UserController = {
    handleStatus(data) {
      const existing = model.users.get(data.user_id);
      if (existing) {
        existing.status = data.status;
      } else {
        model.users.set(data.user_id, { id: data.user_id, username: data.username, status: data.status });
      }
      SidebarView.renderUsersList(
        model.users,
        model.userId,
        model.selectedChat,
        ChatController.selectUser,
        CallController.start1on1Call
      );

      if (model.selectedChat && model.selectedChat.type === "user" && model.selectedChat.id === data.user_id) {
        DOM.peerStatusDot.classList.toggle("online", data.status === "online");
        DOM.peerSubtitle.textContent = data.status === "online" ? "متصل الآن بالشبكة" : "غير متصل";
      }
    },
  };

  // Controller: الدردشة والمراسلة
  const ChatController = {
    init() {
      DOM.messageForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = DOM.messageInput.value.trim();
        if (!text || !model.selectedChat) return;

        if (model.selectedChat.type === "user") {
          WebSocketController.send({ type: "chat_message", to: model.selectedChat.id, message: text });
        } else {
          WebSocketController.send({ type: "group_message", group_id: model.selectedChat.id, message: text });
        }
        DOM.messageInput.value = "";
      });

      DOM.backToListBtn.addEventListener("click", () => {
        if (DOM.sidebar) DOM.sidebar.classList.remove("collapsed");
      });
    },

    async selectUser(userId) {
      model.selectedChat = { type: "user", id: userId };
      SidebarView.renderUsersList(
        model.users,
        model.userId,
        model.selectedChat,
        ChatController.selectUser,
        CallController.start1on1Call
      );
      SidebarView.renderGroupsList(
        model.groups,
        model.selectedChat,
        model.activeGroupCall,
        ChatController.selectGroup
      );

      const u = model.users.get(userId);
      ChatView.setupChatUI("user", u);

      try {
        const history = await model.api(`/api/messages/${userId}`);
        for (const m of history) ChatView.appendBubble(m, "user", model.userId, model.users);
        ChatView.scrollToBottom();
      } catch (err) {
        ToastView.show("تعذر جلب سجل الرسائل: " + err.message);
      }
    },

    async selectGroup(groupId) {
      model.selectedChat = { type: "group", id: groupId };
      SidebarView.renderUsersList(
        model.users,
        model.userId,
        model.selectedChat,
        ChatController.selectUser,
        CallController.start1on1Call
      );
      SidebarView.renderGroupsList(
        model.groups,
        model.selectedChat,
        model.activeGroupCall,
        ChatController.selectGroup
      );

      const g = model.groups.get(groupId);
      ChatView.setupChatUI("group", g);

      try {
        const history = await model.api(`/api/groups/${groupId}/messages`);
        for (const m of history) ChatView.appendBubble(m, "group", model.userId, model.users);
        ChatView.scrollToBottom();
      } catch (err) {
        ToastView.show("تعذر جلب سجل رسائل المجموعة: " + err.message);
      }
    },

    handleIncomingDirect(data) {
      const otherPartyId = data.from === model.userId ? data.to : data.from;
      const isOpen = model.selectedChat && model.selectedChat.type === "user" && model.selectedChat.id === otherPartyId;

      if (isOpen) {
        ChatView.appendBubble({ sender_id: data.from, message: data.message, timestamp: data.timestamp }, "user", model.userId, model.users);
        ChatView.scrollToBottom();
      } else if (data.from !== model.userId) {
        const sender = model.users.get(data.from);
        ToastView.show(`رسالة جديدة من ${sender ? sender.username : "مستخدم"}`);
      }
    },

    handleIncomingGroup(data) {
      const isOpen = model.selectedChat && model.selectedChat.type === "group" && model.selectedChat.id === data.group_id;
      if (isOpen) {
        ChatView.appendBubble({ sender_id: data.from, message: data.message, timestamp: data.timestamp }, "group", model.userId, model.users);
        ChatView.scrollToBottom();
      } else if (data.from !== model.userId) {
        const group = model.groups.get(data.group_id);
        ToastView.show(`رسالة جديدة في ${group ? group.name : "مجموعة"}`);
      }
    },
  };

  // Controller: المكالمات الثنائية (1:1 WebRTC Call Controller)
  const CallController = {
    init() {
      DOM.voiceCallBtn.addEventListener("click", () => {
        if (!model.selectedChat) return;
        if (model.selectedChat.type === "user") CallController.start1on1Call(model.selectedChat.id, "voice");
        else GroupCallController.start(model.selectedChat.id);
      });

      DOM.videoCallBtn.addEventListener("click", () => {
        if (!model.selectedChat || model.selectedChat.type !== "user") return;
        CallController.start1on1Call(model.selectedChat.id, "video");
      });

      DOM.incomingAcceptBtn.addEventListener("click", () => CallController.acceptCall());
      DOM.incomingRejectBtn.addEventListener("click", () => CallController.rejectCall());
      DOM.outgoingCancelBtn.addEventListener("click", () => CallController.cancelOutgoingCall());

      DOM.ctrlMicBtn.addEventListener("click", () => CallController.toggleMic());
      DOM.ctrlCamBtn.addEventListener("click", () => CallController.toggleCamera());
      DOM.ctrlSpeakerBtn.addEventListener("click", () => CallController.toggleSpeaker());
      DOM.ctrlFullscreenBtn.addEventListener("click", () => CallController.toggleFullscreen());
      DOM.ctrlHangupBtn.addEventListener("click", () => CallController.hangup());
    },

    async getLocalMedia(callType = "voice") {
      if (model.localStream) {
        if (callType === "video" && model.localStream.getVideoTracks().length === 0) {
          CallController.stopMediaStream(model.localStream);
          model.localStream = null;
        } else {
          return model.localStream;
        }
      }

      const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const constraints = callType === "video"
        ? { audio: audioConstraints, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } }
        : { audio: audioConstraints, video: false };

      try {
        model.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        return model.localStream;
      } catch (err) {
        if (callType === "video") {
          try {
            model.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            return model.localStream;
          } catch (retryErr) {
            CallController.handleMediaError(retryErr, "video");
            throw retryErr;
          }
        } else {
          CallController.handleMediaError(err, "audio");
          throw err;
        }
      }
    },

    handleMediaError(err, type) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        ToastView.show(type === "video" ? "تم رفض إذن الكاميرا أو الميكروفون من المتصفح." : "تم رفض إذن الميكروفون.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        ToastView.show(type === "video" ? "لم يتم العثور على كاميرا أو ميكروفون متصل." : "لم يتم العثور على ميكروفون متصل.");
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        ToastView.show("الكاميرا أو الميكروفون قيد الاستخدام بواسطة تطبيق آخر.");
      } else {
        ToastView.show("تعذر الوصول لوسائط الجهاز: " + err.message);
      }
    },

    stopMediaStream(stream) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    },

    createPeerConnection(remoteUserId) {
      const pc = new RTCPeerConnection(RTC_CONFIG);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          WebSocketController.send({ type: "ice_candidate", to: remoteUserId, candidate: event.candidate });
        }
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        model.remoteStream = stream;
        DOM.remoteVideo.srcObject = stream;
        DOM.remoteVideo.classList.remove("hidden");

        const hasVideo = stream.getVideoTracks().some((t) => t.enabled);
        if (hasVideo && model.callType === "video") {
          DOM.remoteAudioPlaceholder.classList.add("hidden");
        } else {
          DOM.remoteAudioPlaceholder.classList.remove("hidden");
        }

        event.track.onmute = () => {
          if (event.track.kind === "video") DOM.remoteAudioPlaceholder.classList.remove("hidden");
        };
        event.track.onunmute = () => {
          if (event.track.kind === "video") DOM.remoteAudioPlaceholder.classList.add("hidden");
        };
      };

      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case "connected":
            model.callState = CallState.CONNECTED;
            CallStageView.updateQuality("متصل ممتاز", "var(--online)");
            CallController.startTimer();
            break;
          case "connecting":
            model.callState = CallState.CONNECTING;
            CallStageView.updateQuality("جارٍ الربط...", "var(--text-muted)");
            break;
          case "disconnected":
            CallStageView.updateQuality("انقطع الاتصال", "var(--warning)");
            ToastView.show("انقطع الاتصال بالطرف الآخر");
            break;
          case "failed":
          case "closed":
            if (model.callState !== CallState.IDLE) CallController.endCallLocally();
            break;
        }
      };

      return pc;
    },

    async start1on1Call(peerId, callType = "voice") {
      if (model.callState !== CallState.IDLE) {
        ToastView.show("أنت في مكالمة حالياً، أنهِها أولاً.");
        return;
      }
      if (model.activeGroupCall) {
        ToastView.show("أنت في مكالمة جماعية، غادرها أولاً.");
        return;
      }

      model.callState = CallState.CALLING;
      model.callType = callType;
      model.activeCallPeerId = peerId;
      model.cameraEnabled = callType === "video";
      model.micMuted = false;
      model.speakerMuted = false;

      const peer = model.users.get(peerId);
      const peerName = peer ? peer.username : "المستخدم";

      ModalsView.showOutgoing(peerName, callType);

      try {
        const stream = await CallController.getLocalMedia(callType);
        DOM.localVideo.srcObject = stream;

        const pc = CallController.createPeerConnection(peerId);
        model.pc = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        WebSocketController.send({
          type: "call_offer",
          to: peerId,
          call_type: callType,
          sdp: offer.sdp,
        });
      } catch (err) {
        CallController.endCallLocally();
      }
    },

    async handleOffer(data) {
      if (model.callState !== CallState.IDLE || model.activeGroupCall) {
        WebSocketController.send({ type: "call_busy", to: data.from });
        return;
      }

      model.callState = CallState.RINGING;
      model.activeCallPeerId = data.from;
      model.callType = data.call_type || "voice";
      model.pendingOffer = data;
      model.cameraEnabled = model.callType === "video";
      model.micMuted = false;
      model.speakerMuted = false;

      const caller = model.users.get(data.from);
      const callerName = caller ? caller.username : "مستخدم في الشبكة";
      ModalsView.showIncoming(callerName, model.callType);
    },

    async acceptCall() {
      ModalsView.hideIncoming();
      if (!model.pendingOffer) return;

      const data = model.pendingOffer;
      model.pendingOffer = null;
      model.callState = CallState.ACCEPTED;

      const caller = model.users.get(data.from);
      const callerName = caller ? caller.username : "المتصل";

      CallStageView.show(callerName, model.callType);
      CallStageView.updateControls(model.micMuted, model.cameraEnabled, model.speakerMuted, model.callType);

      try {
        const stream = await CallController.getLocalMedia(model.callType);
        DOM.localVideo.srcObject = stream;

        const pc = CallController.createPeerConnection(data.from);
        model.pc = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: data.sdp }));

        while (model.pendingCandidates.length > 0) {
          const cand = model.pendingCandidates.shift();
          await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        WebSocketController.send({
          type: "call_answer",
          to: data.from,
          sdp: answer.sdp,
        });

        model.callState = CallState.CONNECTING;
      } catch (err) {
        CallController.endCallLocally();
      }
    },

    rejectCall() {
      ModalsView.hideIncoming();
      if (model.activeCallPeerId) {
        WebSocketController.send({ type: "call_reject", to: model.activeCallPeerId });
      }
      CallController.endCallLocally();
    },

    cancelOutgoingCall() {
      ModalsView.hideOutgoing();
      if (model.activeCallPeerId) {
        WebSocketController.send({ type: "call_end", to: model.activeCallPeerId });
      }
      CallController.endCallLocally();
    },

    async handleAnswer(data) {
      ModalsView.hideOutgoing();
      if (!model.pc) return;

      const peer = model.users.get(data.from);
      const peerName = peer ? peer.username : "المستخدم";

      CallStageView.show(peerName, model.callType);
      CallStageView.updateControls(model.micMuted, model.cameraEnabled, model.speakerMuted, model.callType);

      try {
        await model.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
        while (model.pendingCandidates.length > 0) {
          const cand = model.pendingCandidates.shift();
          await model.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
      } catch (err) {
        CallController.endCallLocally();
      }
    },

    async handleRemoteCandidate(data) {
      if (model.pc && model.pc.remoteDescription && model.pc.remoteDescription.type) {
        try {
          await model.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch {}
      } else {
        model.pendingCandidates.push(data.candidate);
      }
    },

    handleReject() {
      ModalsView.hideOutgoing();
      ToastView.show("تم رفض المكالمة من الطرف الآخر.");
      CallController.endCallLocally();
    },

    handleBusy() {
      ModalsView.hideOutgoing();
      ToastView.show("المستخدم مشغول في مكالمة أخرى حالياً.");
      CallController.endCallLocally();
    },

    handleRemoteEnd() {
      ToastView.show("أنهى الطرف الآخر المكالمة.");
      CallController.endCallLocally();
    },

    handleError(data) {
      ToastView.show("خطأ في المكالمة: " + (data.message || ""));
      CallController.endCallLocally();
    },

    handleRemoteMediaState(data) {
      if (data.mic_muted !== undefined) {
        ToastView.showPeerStatus(data.mic_muted ? "كتم الطرف الآخر الميكروفون" : "ألغى الطرف الآخر كتم الميكروفون");
      }
      if (data.camera_off !== undefined) {
        ToastView.showPeerStatus(data.camera_off ? "أوقف الطرف الآخر الكاميرا" : "شغّل الطرف الآخر الكاميرا");
        if (data.camera_off) {
          DOM.remoteAudioPlaceholder.classList.remove("hidden");
          CallStageView.setRemoteMediaNotice("الكاميرا مطفأة لدى الطرف الآخر");
        } else {
          DOM.remoteAudioPlaceholder.classList.add("hidden");
          CallStageView.setRemoteMediaNotice("");
        }
      }
    },

    toggleMic() {
      if (!model.localStream) return;
      model.micMuted = !model.micMuted;
      model.localStream.getAudioTracks().forEach((t) => (t.enabled = !model.micMuted));
      CallStageView.updateControls(model.micMuted, model.cameraEnabled, model.speakerMuted, model.callType);

      if (model.activeCallPeerId) {
        WebSocketController.send({
          type: "media_state",
          to: model.activeCallPeerId,
          mic_muted: model.micMuted,
        });
      }
    },

    toggleCamera() {
      if (!model.localStream || model.callType !== "video") return;
      model.cameraEnabled = !model.cameraEnabled;
      model.localStream.getVideoTracks().forEach((t) => (t.enabled = model.cameraEnabled));
      CallStageView.updateControls(model.micMuted, model.cameraEnabled, model.speakerMuted, model.callType);

      if (model.activeCallPeerId) {
        WebSocketController.send({
          type: "media_state",
          to: model.activeCallPeerId,
          camera_off: !model.cameraEnabled,
        });
      }
    },

    toggleSpeaker() {
      model.speakerMuted = !model.speakerMuted;
      DOM.remoteVideo.muted = model.speakerMuted;
      CallStageView.updateControls(model.micMuted, model.cameraEnabled, model.speakerMuted, model.callType);
    },

    toggleFullscreen() {
      if (!document.fullscreenElement) {
        DOM.callStageContainer.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    },

    hangup() {
      if (model.activeCallPeerId) {
        WebSocketController.send({ type: "call_end", to: model.activeCallPeerId });
      }
      CallController.endCallLocally();
    },

    endCallLocally() {
      model.callState = CallState.ENDED;
      CallController.stopTimer();

      if (model.pc) {
        model.pc.close();
        model.pc = null;
      }

      if (model.localStream && !model.activeGroupCall) {
        CallController.stopMediaStream(model.localStream);
        model.localStream = null;
      }
      model.remoteStream = null;

      model.pendingOffer = null;
      model.pendingCandidates = [];
      model.activeCallPeerId = null;
      model.activeCallId = null;

      ModalsView.hideIncoming();
      ModalsView.hideOutgoing();
      CallStageView.hide();

      model.callState = CallState.IDLE;
    },

    startTimer() {
      CallController.stopTimer();
      model.callSeconds = 0;
      CallStageView.updateTimer(0);
      model.callTimerInterval = setInterval(() => {
        model.callSeconds += 1;
        CallStageView.updateTimer(model.callSeconds);
      }, 1000);
    },

    stopTimer() {
      if (model.callTimerInterval) {
        clearInterval(model.callTimerInterval);
        model.callTimerInterval = null;
      }
    },
  };

  // Controller: المكالمات الجماعية (Mesh Voice Call Controller)
  const GroupCallController = {
    init() {
      DOM.gcbLeaveBtn.addEventListener("click", () => GroupCallController.leave());
      DOM.gcbMuteBtn.addEventListener("click", () => GroupCallController.toggleMic());

      DOM.newGroupBtn.addEventListener("click", () => {
        ModalsView.showNewGroup(model.users, model.userId);
      });
      DOM.newGroupCancelBtn.addEventListener("click", () => ModalsView.hideNewGroup());
      DOM.newGroupCreateBtn.addEventListener("click", () => GroupCallController.createGroup());
    },

    async createGroup() {
      const name = DOM.newGroupNameInput.value.trim();
      if (!name) {
        DOM.newGroupError.textContent = "اسم المجموعة مطلوب";
        return;
      }

      const memberIds = [];
      DOM.newGroupMembers.querySelectorAll("input[type=checkbox]:checked").forEach((cb) => {
        memberIds.push(Number(cb.value));
      });

      try {
        const created = await model.api("/api/groups", {
          method: "POST",
          body: { name, member_ids: memberIds },
        });
        model.groups.set(created.id, created);
        SidebarView.renderGroupsList(model.groups, model.selectedChat, model.activeGroupCall, ChatController.selectGroup);
        ModalsView.hideNewGroup();
        ChatController.selectGroup(created.id);
      } catch (err) {
        DOM.newGroupError.textContent = err.message;
      }
    },

    async start(groupId) {
      if (model.callState !== CallState.IDLE) {
        ToastView.show("أنت في مكالمة ثنائية حالياً");
        return;
      }
      if (model.activeGroupCall) {
        ToastView.show("أنت في مكالمة جماعية مسبقاً");
        return;
      }

      try {
        const stream = await CallController.getLocalMedia("voice");
        model.activeGroupCall = { groupId, callId: null };
        model.groupMicMuted = false;

        WebSocketController.send({ type: "group_call_start", group_id: groupId });
        GroupCallView.renderBar(model.activeGroupCall, model.groups.get(groupId), model.groupParticipants, model.groupMicMuted);
      } catch (err) {
        ToastView.show("تعذر بدء المكالمة الجماعية: " + err.message);
      }
    },

    async join(groupId) {
      if (model.callState !== CallState.IDLE) {
        ToastView.show("أنت في مكالمة ثنائية حالياً");
        return;
      }

      try {
        await CallController.getLocalMedia("voice");
        model.activeGroupCall = { groupId, callId: null };
        model.groupMicMuted = false;

        WebSocketController.send({ type: "group_call_join", group_id: groupId });
        GroupCallView.renderBar(model.activeGroupCall, model.groups.get(groupId), model.groupParticipants, model.groupMicMuted);
      } catch (err) {
        ToastView.show("تعذر الانضمام للمكالمة الجماعية: " + err.message);
      }
    },

    leave() {
      if (model.activeGroupCall) {
        WebSocketController.send({ type: "group_call_leave", group_id: model.activeGroupCall.groupId });
      }
      GroupCallController.leaveLocally();
    },

    leaveLocally() {
      for (const [, pc] of model.groupPeerConnections) pc.close();
      model.groupPeerConnections.clear();
      model.groupPendingCandidates.clear();
      model.groupParticipants.clear();
      DOM.remoteAudiosContainer.innerHTML = "";

      if (model.localStream && model.callState === CallState.IDLE) {
        CallController.stopMediaStream(model.localStream);
        model.localStream = null;
      }

      model.activeGroupCall = null;
      model.groupMicMuted = false;
      GroupCallView.renderBar(null);
      SidebarView.renderGroupsList(model.groups, model.selectedChat, null, ChatController.selectGroup);
    },

    toggleMic() {
      if (!model.localStream) return;
      model.groupMicMuted = !model.groupMicMuted;
      model.localStream.getAudioTracks().forEach((t) => (t.enabled = !model.groupMicMuted));
      DOM.gcbMuteBtn.textContent = model.groupMicMuted ? "إلغاء الكتم" : "كتم";
    },

    handleIncoming(data) {
      const g = model.groups.get(data.group_id);
      const name = g ? g.name : "مجموعة";
      GroupCallView.showInvite(
        name,
        () => GroupCallController.join(data.group_id),
        () => {}
      );
    },

    handleRoster(data) {
      model.groupParticipants.clear();
      (data.participants || []).forEach((p) => {
        if (p.user_id !== model.userId) model.groupParticipants.set(p.user_id, p.username);
      });

      const g = model.groups.get(data.group_id);
      GroupCallView.renderBar(model.activeGroupCall, g, model.groupParticipants, model.groupMicMuted);

      (data.participants || []).forEach(async (p) => {
        if (p.user_id !== model.userId) {
          await GroupCallController.initPeerConnection(p.user_id, true);
        }
      });
    },

    async handleParticipantJoined(data) {
      if (data.user_id !== model.userId) {
        model.groupParticipants.set(data.user_id, data.username);
        const g = model.activeGroupCall ? model.groups.get(model.activeGroupCall.groupId) : null;
        GroupCallView.renderBar(model.activeGroupCall, g, model.groupParticipants, model.groupMicMuted);
      }
    },

    handleParticipantLeft(data) {
      model.groupParticipants.delete(data.user_id);
      const pc = model.groupPeerConnections.get(data.user_id);
      if (pc) {
        pc.close();
        model.groupPeerConnections.delete(data.user_id);
      }
      const audioEl = $(`group-audio-${data.user_id}`);
      if (audioEl) audioEl.remove();

      const g = model.activeGroupCall ? model.groups.get(model.activeGroupCall.groupId) : null;
      GroupCallView.renderBar(model.activeGroupCall, g, model.groupParticipants, model.groupMicMuted);
    },

    async initPeerConnection(remoteUserId, isInitiator) {
      if (model.groupPeerConnections.has(remoteUserId)) return;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      model.groupPeerConnections.set(remoteUserId, pc);

      if (model.localStream) {
        model.localStream.getAudioTracks().forEach((track) => pc.addTrack(track, model.localStream));
      }

      pc.ontrack = (event) => {
        let audioEl = $(`group-audio-${remoteUserId}`);
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.id = `group-audio-${remoteUserId}`;
          audioEl.autoplay = true;
          DOM.remoteAudiosContainer.appendChild(audioEl);
        }
        audioEl.srcObject = event.streams[0] || new MediaStream([event.track]);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          WebSocketController.send({
            type: "ice_candidate",
            to: remoteUserId,
            candidate: event.candidate,
          });
        }
      };

      if (isInitiator) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          WebSocketController.send({
            type: "call_offer",
            to: remoteUserId,
            call_type: "voice",
            sdp: offer.sdp,
          });
        } catch {}
      }
    },
  };

  // Controller: المنسق العام للتطبيق (App Controller)
  const AppController = {
    async loadInitialData() {
      try {
        const [users, groups] = await Promise.all([
          model.api("/api/users"),
          model.api("/api/groups"),
        ]);

        model.users.clear();
        for (const u of users) model.users.set(u.id, u);
        SidebarView.renderUsersList(
          model.users,
          model.userId,
          model.selectedChat,
          ChatController.selectUser,
          CallController.start1on1Call
        );

        model.groups.clear();
        for (const g of groups) model.groups.set(g.id, g);
        SidebarView.renderGroupsList(
          model.groups,
          model.selectedChat,
          model.activeGroupCall,
          ChatController.selectGroup
        );
      } catch (err) {
        if (err.message === "UNAUTHORIZED") {
          AuthController.logout(false);
          ToastView.show("انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً");
        } else {
          ToastView.show("خطأ أثناء تحميل البيانات: " + err.message);
        }
      }
    },

    init() {
      ThemeController.init();
      AuthController.init();
      ChatController.init();
      CallController.init();
      GroupCallController.init();

      // التحقق من تسجيل الدخول السابق (Auto-login)
      if (model.token && model.userId) {
        AuthController.enterApp();
      }
    },
  };

  /* =========================================================================
     [MVC GLOBAL EXPORT & INITIALIZATION]
     ========================================================================= */

  window.MVC = {
    Models: { CallState, AppModel, model },
    Views: { DOM, ThemeView, ToastView, AuthView, SidebarView, ChatView, CallStageView, ModalsView, GroupCallView },
    Controllers: { ThemeController, AuthController, WebSocketController, UserController, ChatController, CallController, GroupCallController, AppController },
  };

  // تشغيل بيئة العميل
  document.addEventListener("DOMContentLoaded", () => {
    AppController.init();
  });

  // إذا كانت الشجرة محملة مسبقاً
  if (document.readyState === "complete" || document.readyState === "interactive") {
    AppController.init();
  }
})();
