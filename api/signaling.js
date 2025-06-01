<script>
    // Enhanced WebRTC Chat with GET API + Optimizations
    if (!window.RTCPeerConnection) {
      alert('Your browser does not support WebRTC. Please use the latest Chrome, Firefox, Safari, or Edge.');
    }

    // Global variables with enhanced management
    let localConnection, dataChannel, isConnected = false, isInitiator = false;
    let currentMatch = null, myUserId = generateUserId(), partnerInfo = null;
    
    // Enhanced retry and connection management
    let retryAttempts = 0, signalingInterval = null, heartbeatInterval = null;
    const maxRetryAttempts = 3, baseRetryDelay = 10000, maxIceCandidates = 10;
    let retryTimeoutId = null, isRetrying = false, isConnecting = false;
    let connectionStartTime = null;
    
    // ICE candidates management for low-end devices
    let iceCandidatesQueue = [], signalingUrl = 'https://comjp.vercel.app/api/signaling';
    let pendingSignalIds = [], connectionTimeout = null, offerTimeout = null, answerTimeout = null;
    let connectionState = 'disconnected', lastPingTime = 0, batchedSignals = {};
    let signalingActive = false, adaptivePollingDelay = 5000, greetingSent = false;
    let batchTimeout = null, iceGatheringComplete = false;
    
    // Notifications
    let notificationsEnabled = false, notificationPermission = 'default';
    let lastNotificationTime = 0;

    // Performance monitoring
    let performanceMetrics = {
      connectionStartTime: null,
      matchFoundTime: null,
      webrtcConnectedTime: null,
      messagesSent: 0,
      messagesReceived: 0
    };

    // DOM elements
    const statusEl = document.getElementById('status');
    const statusIndicator = document.querySelector('.status-indicator');
    const statusText = document.querySelector('.status-text');
    const nameInput = document.getElementById('name');
    const genderSelect = document.getElementById('gender');
    const statusTextInput = document.getElementById('status-text');
    const avatarDiv = document.getElementById('avatar');
    const messagesEl = document.getElementById('messages');
    const messageInput = document.getElementById('message');
    const sendBtn = document.getElementById('send');
    const disconnectBtn = document.getElementById('disconnect-btn');
    const notificationBtn = document.getElementById('notification-btn');
    const imageInput = document.getElementById('image-file');
    const avatarFileInput = document.getElementById('avatar-file');
    const avatarUrlInput = document.getElementById('avatar-url');

    function initApp() {
      console.log('[INIT] Starting Enhanced WebRTC chat application');
      performanceMetrics.connectionStartTime = Date.now();
      
      initializeNotifications();
      
      let userName = sessionStorage.getItem('name');
      if (!userName) {
        userName = `User_${myUserId.slice(-4)}`;
        sessionStorage.setItem('name', userName);
      }
      if (nameInput) nameInput.value = userName;

      const gender = sessionStorage.getItem('gender') || 'Unspecified';
      if (genderSelect) genderSelect.value = gender;

      const userStatus = sessionStorage.getItem('status') || '';
      if (statusTextInput) statusTextInput.value = userStatus;

      const avatar = sessionStorage.getItem('avatar');
      if (avatar) {
        setAvatar(avatar);
      }

      setupEventListeners();
      startMatchFinding();
      startHeartbeat();
      
      // Performance mark
      if (window.performance && window.performance.mark) {
        window.performance.mark('webrtc-app-start');
      }
    }

    async function initializeNotifications() {
      const savedPref = localStorage.getItem('notificationsEnabled');
      notificationsEnabled = savedPref === 'true';
      
      if ('Notification' in window) {
        notificationPermission = Notification.permission;
        
        if (notificationPermission === 'default' && notificationsEnabled) {
          try {
            notificationPermission = await Notification.requestPermission();
          } catch (error) {
            console.error('Notification permission error:', error);
            notificationPermission = 'denied';
          }
        }
        
        notificationsEnabled = notificationsEnabled && notificationPermission === 'granted';
      } else {
        notificationsEnabled = false;
      }
      
      updateNotificationButtonState();
    }

    function updateNotificationButtonState() {
      if (notificationBtn) {
        if (notificationsEnabled) {
          notificationBtn.classList.remove('disabled');
          notificationBtn.setAttribute('data-tooltip', 'Notifications enabled');
        } else {
          notificationBtn.classList.add('disabled');
          notificationBtn.setAttribute('data-tooltip', 'Notifications disabled');
        }
        
        if (isConnected) {
          notificationBtn.style.display = 'block';
        }
      }
    }

    async function toggleNotifications() {
      if ('Notification' in window) {
        if (notificationPermission === 'denied') {
          alert('Notifications are blocked. Please enable them in your browser settings.');
          return;
        }
        
        if (notificationPermission === 'default') {
          try {
            notificationPermission = await Notification.requestPermission();
          } catch (error) {
            alert('Could not request notification permission.');
            return;
          }
        }
        
        if (notificationPermission === 'granted') {
          notificationsEnabled = !notificationsEnabled;
          localStorage.setItem('notificationsEnabled', notificationsEnabled.toString());
        }
      } else {
        alert('Notifications are not supported in this browser.');
        return;
      }
      
      updateNotificationButtonState();
      
      if (notificationsEnabled) {
        showNotification('Notifications enabled', 'You will receive notifications for new messages and events.', 'system');
      }
    }

    function shouldShowNotification() {
      if (!notificationsEnabled) return false;
      if (!dataChannel || dataChannel.readyState !== 'open') return false;
      
      const now = Date.now();
      if (now - lastNotificationTime < 3000) return false;
      
      if (typeof document.hasFocus === 'function' && document.hasFocus()) return false;
      if (typeof document.hidden !== 'undefined' && !document.hidden) return false;
      
      return true;
    }

    function showNotification(title, body, type = 'message', data = {}) {
      if (!shouldShowNotification() && type !== 'system') return;
      
      const now = Date.now();
      lastNotificationTime = now;
      
      if ('Notification' in window && notificationPermission === 'granted') {
        try {
          const notification = new Notification(title, {
            body: body,
            tag: type,
            requireInteraction: type === 'connection',
            silent: type === 'system',
            timestamp: now,
            icon: '/favicon.ico'
          });
          
          notification.onclick = () => {
            window.focus();
            notification.close();
            if (messageInput) messageInput.focus();
          };
          
          setTimeout(() => {
            notification.close();
          }, type === 'connection' ? 10000 : 5000);
          
        } catch (error) {
          console.error('Web notification error:', error);
        }
      }
    }

    function generateUserId() {
      return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    }

    function generateGreeting(partnerInfo) {
      const greetings = [
        `Hi there! I'm ${partnerInfo.name}`,
        `Hello! Nice to meet you, I'm ${partnerInfo.name}`,
        `Hey! ${partnerInfo.name} here`,
        `Hi! I'm ${partnerInfo.name}, nice to connect!`,
        `Hello there! ${partnerInfo.name} is my name`
      ];
      
      let greeting = greetings[Math.floor(Math.random() * greetings.length)];
      
      if (partnerInfo.gender && partnerInfo.gender !== 'Unspecified') {
        greeting += ` (${partnerInfo.gender})`;
      }
      
      if (partnerInfo.status && partnerInfo.status.trim()) {
        greeting += `. ${partnerInfo.status}`;
      }
      
      return greeting;
    }

    // Enhanced GET API call with improved error handling
 async function apiCall(data) {
  try {
    const params = new URLSearchParams();
    params.append('userId', myUserId);
    
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'object') {
          params.append(key, encodeURIComponent(JSON.stringify(value)));
        } else if (typeof value === 'boolean') {
          params.append(key, value.toString());
        } else {
          params.append(key, value);
        }
      }
    }
    
    const url = `${signalingUrl}?${params.toString()}`;
    
    // Bỏ headers hoàn toàn
    const response = await fetch(url, {
      method: 'GET'
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
    
  } catch (error) {
    throw new Error(`API call failed: ${error.message}`);
  }
}
    async function startMatchFinding() {
      // Prevent multiple simultaneous connection attempts
      if (isConnecting) {
        console.log('[CONNECT] Connection attempt already in progress');
        return;
      }

      // Check if we've exceeded retry attempts
      if (retryAttempts >= maxRetryAttempts) {
        console.error('[CONNECT] Maximum retry attempts exceeded');
        updateStatus('Connection failed. Please refresh the page.', 'error');
        addSystemMessage('Unable to connect to server. Please refresh the page to try again.');
        return;
      }

      if (currentMatch) {
        return;
      }

      try {
        isConnecting = true;
        connectionStartTime = Date.now();
        
        const isRetryAttempt = retryAttempts > 0;
        const statusMessage = isRetryAttempt ? 
          `Reconnecting... (${retryAttempts}/${maxRetryAttempts})` : 
          'Looking for someone to chat with...';
        
        updateStatus(statusMessage, 'searching');
        console.log(`[CONNECT] Attempt ${retryAttempts + 1}/${maxRetryAttempts + 1}`);
        
        const result = await apiCall({
          action: 'find-match',
          timezone: getTimezoneOffset()
        });

        if (result.status === 'matched') {
          // Reset retry state on successful match
          retryAttempts = 0;
          isConnecting = false;
          isRetrying = false;
          
          // Clear any pending retry timeouts
          if (retryTimeoutId) {
            clearTimeout(retryTimeoutId);
            retryTimeoutId = null;
          }
          
          performanceMetrics.matchFoundTime = Date.now();
          const matchTime = performanceMetrics.matchFoundTime - connectionStartTime;
          console.log(`[MATCH] Found match in ${matchTime}ms`);
          
          currentMatch = {
            matchId: result.matchId,
            partnerId: result.partnerId,
            isInitiator: result.isInitiator,
            existing: result.existing
          };
          
          updateStatus('Found someone! Connecting...', 'signaling');
          addSystemMessage(`Matched with someone! Setting up connection...`);
          
          await createPeerConnection();
          startSignalingLoop();
          signalingActive = true;
          greetingSent = false;
          
          if (result.isInitiator && !result.existing) {
            setupOfferTimeout();
            setTimeout(() => createOffer(), 1000);
          } else {
            setupAnswerTimeout();
          }

          setupConnectionTimeout();
          
        } else if (result.status === 'waiting') {
          isConnecting = false;
          updateStatus(`Waiting for match... (${result.position} in queue)`, 'searching');
          setTimeout(() => startMatchFinding(), 5000);
        } else {
          throw new Error(result.message || 'Unknown error');
        }
        
      } catch (error) {
        console.error('[CONNECT] Connection error:', error);
        isConnecting = false;
        
        if (!isRetrying) {
          scheduleRetry();
        }
      }
    }

    // Schedule retry with exponential backoff (from reference code)
    function scheduleRetry() {
      if (isRetrying || retryAttempts >= maxRetryAttempts) {
        return;
      }

      isRetrying = true;
      retryAttempts++;
      
      // Calculate exponential backoff delay: 10s, 20s, 40s
      const delay = baseRetryDelay * Math.pow(2, retryAttempts - 1);
      
      console.log(`[RETRY] Scheduling retry ${retryAttempts}/${maxRetryAttempts} in ${delay}ms`);
      updateStatus(`Connection failed. Retrying in ${Math.round(delay/1000)}s... (${retryAttempts}/${maxRetryAttempts})`, 'error');
      
      retryTimeoutId = setTimeout(() => {
        if (retryAttempts <= maxRetryAttempts) {
          console.log(`[RETRY] Executing retry attempt ${retryAttempts}`);
          isRetrying = false;
          startMatchFinding();
        }
      }, delay);
    }

    function setupOfferTimeout() {
      if (offerTimeout) clearTimeout(offerTimeout);
      offerTimeout = setTimeout(() => {
        if (connectionState !== 'connected' && currentMatch) {
          addSystemMessage('Offer timeout. Trying to reconnect...');
          handleConnectionFailure();
        }
      }, 20000);
    }

    function setupAnswerTimeout() {
      if (answerTimeout) clearTimeout(answerTimeout);
      answerTimeout = setTimeout(() => {
        if (connectionState !== 'connected' && currentMatch) {
          addSystemMessage('Answer timeout. Trying to reconnect...');
          handleConnectionFailure();
        }
      }, 20000);
    }

    function setupConnectionTimeout() {
      if (connectionTimeout) clearTimeout(connectionTimeout);
      connectionTimeout = setTimeout(() => {
        if (connectionState !== 'connected' && currentMatch) {
          addSystemMessage('Connection timeout. Finding new partner...');
          handleConnectionFailure();
        }
      }, 75000);
    }

    function clearAllTimeouts() {
      const timeouts = [connectionTimeout, offerTimeout, answerTimeout, batchTimeout, retryTimeoutId];
      timeouts.forEach(timeout => {
        if (timeout) {
          clearTimeout(timeout);
        }
      });
      
      connectionTimeout = null;
      offerTimeout = null;
      answerTimeout = null;
      batchTimeout = null;
      retryTimeoutId = null;
    }

    // Optimized WebRTC peer connection for low-end devices
    async function createPeerConnection() {
      try {
        console.log('[WEBRTC] Creating optimized peer connection');
        
        // Optimized configuration for low-end devices
        const config = {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ],
          iceTransportPolicy: 'all',
          bundlePolicy: 'balanced',
          iceCandidatePoolSize: 0 // Disable candidate pooling to save resources
        };

        localConnection = new RTCPeerConnection(config);

        // Reset ICE management state
        iceCandidatesQueue = [];
        iceGatheringComplete = false;

        // Handle ICE candidates with throttling for low-end devices
        localConnection.onicecandidate = async (event) => {
          if (event.candidate) {
            // Limit ICE candidates to reduce CPU load
            if (iceCandidatesQueue.length < maxIceCandidates) {
              iceCandidatesQueue.push(event.candidate);
              batchSignalsForSending();
            } else {
              console.log('[WEBRTC] ICE candidate queue full, dropping candidate');
            }
          } else if (event.candidate === null) {
            console.log('[WEBRTC] ICE gathering complete');
            iceGatheringComplete = true;
          }
        };

        localConnection.onconnectionstatechange = () => {
          console.log('[WEBRTC] Connection state:', localConnection.connectionState);
          
          switch (localConnection.connectionState) {
            case 'connected':
              connectionState = 'connected';
              signalingActive = false;
              clearAllTimeouts();
              
              performanceMetrics.webrtcConnectedTime = Date.now();
              const totalTime = performanceMetrics.webrtcConnectedTime - performanceMetrics.connectionStartTime;
              console.log(`[PERFORMANCE] Connected in ${totalTime}ms total`);
              
              updateStatus('Connected! Say hello 👋', 'connected');
              addSystemMessage(`You're now connected with someone new!`);
              stopSignalingLoop();
              sendConnectionReady();
              startPingLoop();
              
              showNotification(
                'Chat Connected!', 
                'You are now connected with someone. Start chatting!',
                'connection'
              );
              break;
            case 'disconnected':
            case 'failed':
            case 'closed':
              if (isConnected) {
                handlePartnerDisconnect();
              }
              break;
          }
        };

        if (currentMatch.isInitiator) {
          dataChannel = localConnection.createDataChannel('messages', {
            ordered: true,
            maxRetransmits: 3 // Limit retransmits for low-end devices
          });
          setupDataChannel(dataChannel);
        }

        localConnection.ondatachannel = (event) => {
          dataChannel = event.channel;
          setupDataChannel(dataChannel);
        };

      } catch (error) {
        console.error('[WEBRTC] Error creating peer connection:', error);
        updateStatus('Connection failed, trying again...', 'error');
        handleConnectionFailure();
      }
    }

    function setupDataChannel(channel) {
      if (!channel) return;
      
      channel.onopen = () => {
        console.log('[DATACHANNEL] Data channel opened');
        isConnected = true;
        sendUserInfo();
        updateNotificationButtonState();
      };

      channel.onclose = () => {
        console.log('[DATACHANNEL] Data channel closed');
        if (isConnected) {
          showNotification(
            'Partner Disconnected', 
            'Your chat partner has left the conversation.',
            'connection'
          );
          handlePartnerDisconnect();
        }
      };

      channel.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          performanceMetrics.messagesReceived++;
          handleDataChannelMessage(data);
        } catch (error) {
          console.error('[DATACHANNEL] Error parsing message:', error, event.data);
        }
      };

      channel.onerror = (error) => {
        console.error('[DATACHANNEL] Error:', error);
        showNotification(
          'Connection Error', 
          'There was an issue with the chat connection.',
          'connection'
        );
      };
    }

    async function createOffer() {
      try {
        console.log('[WEBRTC] Creating offer');
        const offer = await localConnection.createOffer();
        await localConnection.setLocalDescription(offer);
        batchedSignals.offer = offer;
        await sendBatchedSignals();
      } catch (error) {
        console.error('[WEBRTC] Error creating offer:', error);
        handleConnectionFailure();
      }
    }

    async function handleOffer(offer) {
      try {
        await localConnection.setRemoteDescription(offer);
        const answer = await localConnection.createAnswer();
        await localConnection.setLocalDescription(answer);
        batchedSignals.answer = answer;
        await sendBatchedSignals();
        if (answerTimeout) clearTimeout(answerTimeout);
      } catch (error) {
        console.error('[WEBRTC] Error handling offer:', error);
        handleConnectionFailure();
      }
    }

    async function handleAnswer(answer) {
      try {
        await localConnection.setRemoteDescription(answer);
        if (offerTimeout) clearTimeout(offerTimeout);
      } catch (error) {
        console.error('[WEBRTC] Error handling answer:', error);
        handleConnectionFailure();
      }
    }

    async function handleIceCandidate(candidate) {
      try {
        await localConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error('[WEBRTC] Error handling ICE candidate:', error);
      }
    }

    function batchSignalsForSending() {
      if (!signalingActive) return;
      
      if (batchTimeout) clearTimeout(batchTimeout);
      batchTimeout = setTimeout(() => {
        if (iceCandidatesQueue.length > 0) {
          batchedSignals.ice = [...iceCandidatesQueue];
          iceCandidatesQueue = [];
          sendBatchedSignals();
        }
      }, 1000);
    }

    async function sendBatchedSignals() {
      if (!currentMatch || !signalingActive) return;

      try {
        const payload = {
          action: 'exchange-signals',
          matchId: currentMatch.matchId,
          acknowledgeIds: pendingSignalIds.length > 0 ? pendingSignalIds : undefined
        };

        if (batchedSignals.offer) {
          payload.offer = batchedSignals.offer;
          delete batchedSignals.offer;
        }

        if (batchedSignals.answer) {
          payload.answer = batchedSignals.answer;
          delete batchedSignals.answer;
        }

        if (batchedSignals.ice && batchedSignals.ice.length > 0) {
          payload.ice = batchedSignals.ice;
          delete batchedSignals.ice;
        }

        if (payload.offer || payload.answer || payload.ice || payload.acknowledgeIds) {
          const result = await apiCall(payload);

          if (result.signalIds) {
            pendingSignalIds = [];
          }

          if (result.signals) {
            await processSignals(result.signals);
          }

          adaptivePollingDelay = Math.max(3000, adaptivePollingDelay - 500);
        }
      } catch (error) {
        console.error('[SIGNALING] Failed to send batched signals:', error);
        adaptivePollingDelay = Math.min(15000, adaptivePollingDelay + 1000);
      }
    }

    async function sendConnectionReady() {
      if (!currentMatch) return;

      try {
        await apiCall({
          action: 'exchange-signals',
          matchId: currentMatch.matchId,
          connectionReady: true,
          acknowledgeIds: pendingSignalIds.length > 0 ? pendingSignalIds : undefined
        });
        pendingSignalIds = [];
      } catch (error) {
        console.error('[SIGNALING] Failed to send connection ready:', error);
      }
    }

    function startSignalingLoop() {
      if (signalingInterval) clearInterval(signalingInterval);
      
      signalingInterval = setInterval(async () => {
        if (!currentMatch || !signalingActive) {
          stopSignalingLoop();
          return;
        }
        
        try {
          const payload = {
            action: 'exchange-signals',
            matchId: currentMatch.matchId,
            acknowledgeIds: pendingSignalIds.length > 0 ? pendingSignalIds : undefined
          };

          if (iceCandidatesQueue.length > 0) {
            payload.ice = [...iceCandidatesQueue];
            iceCandidatesQueue = [];
          }

          const result = await apiCall(payload);
          
          if (result && result.signalIds) {
            pendingSignalIds = [];
          }
          
          if (result && result.signals) {
            await processSignals(result.signals);
          }

          adaptivePollingDelay = Math.max(3000, adaptivePollingDelay - 200);
        } catch (error) {
          console.error('[SIGNALING] Loop failed:', error);
          adaptivePollingDelay = Math.min(15000, adaptivePollingDelay + 1000);
          
          if (error.message.includes('HTTP 500') || error.message.includes('Network')) {
            stopSignalingLoop();
            handleConnectionFailure();
          }
        }
      }, adaptivePollingDelay);
    }

    function stopSignalingLoop() {
      if (signalingInterval) {
        clearInterval(signalingInterval);
        signalingInterval = null;
      }
      signalingActive = false;
    }

    function startHeartbeat() {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      
      heartbeatInterval = setInterval(async () => {
        if (signalingActive) return;
        
        try {
          const result = await apiCall({ action: 'heartbeat' });
          
          if (result.matched && !currentMatch) {
            currentMatch = {
              matchId: result.matchId,
              partnerId: result.partnerId,
              isInitiator: result.isInitiator
            };
            
            updateStatus('Reconnected to existing match...', 'signaling');
            await createPeerConnection();
            startSignalingLoop();
            signalingActive = true;
            
            if (result.isInitiator) {
              setTimeout(() => createOffer(), 1000);
            }
          }
        } catch (error) {
          console.error('[HEARTBEAT] Failed:', error);
        }
      }, 15000);
    }

    function startPingLoop() {
      setInterval(async () => {
        if (isConnected && dataChannel && dataChannel.readyState === 'open') {
          const now = Date.now();
          if (now - lastPingTime > 25000) {
            try {
              dataChannel.send(JSON.stringify({
                type: 'ping',
                timestamp: now
              }));
              lastPingTime = now;
            } catch (error) {
              console.error('[PING] Failed:', error);
            }
          }
        }
      }, 30000);
    }

    async function processSignals(signals) {
      if (!signals) return;
      
      try {
        if (signals.offers && signals.offers.length > 0) {
          for (const offer of signals.offers) {
            await handleOffer(offer.offer);
            pendingSignalIds.push(offer.id);
          }
        }

        if (signals.answers && signals.answers.length > 0) {
          for (const answer of signals.answers) {
            await handleAnswer(answer.answer);
            pendingSignalIds.push(answer.id);
          }
        }

        if (signals.ice && signals.ice.length > 0) {
          for (const ice of signals.ice) {
            await handleIceCandidate(ice.candidate);
            pendingSignalIds.push(ice.id);
          }
        }

        if (signals.acks && signals.acks.length > 0) {
          for (const ack of signals.acks) {
            if (ack.type === 'connection_ready' || ack.type === 'ready') {
              addSystemMessage('Partner is ready! Connection established.');
            } else if (ack.type === 'ping') {
              if (dataChannel && dataChannel.readyState === 'open') {
                dataChannel.send(JSON.stringify({
                  type: 'pong',
                  timestamp: Date.now()
                }));
              }
            }
            pendingSignalIds.push(ack.id);
          }
        }

        if (pendingSignalIds.length > 0) {
          setTimeout(async () => {
            try {
              await apiCall({
                action: 'exchange-signals',
                matchId: currentMatch.matchId,
                acknowledgeIds: [...pendingSignalIds]
              });
              pendingSignalIds = [];
            } catch (error) {
              console.error('[SIGNALING] Failed to acknowledge signals:', error);
            }
          }, 500);
        }
      } catch (error) {
        console.error('[SIGNALING] Error processing signals:', error);
      }
    }

    function handleDataChannelMessage(data) {
      if (!data || !data.type) return;
      
      switch (data.type) {
        case 'user-info':
          partnerInfo = data;
          addSystemMessage(`${data.name || 'Anonymous'} joined the chat!`);
          
          showNotification(
            'Partner Joined!', 
            `${data.name || 'Anonymous'} has joined the chat.`,
            'connection'
          );
          
          if (!greetingSent) {
            greetingSent = true;
            setTimeout(() => {
              const currentName = nameInput ? nameInput.value : 'Anonymous';
              const currentGender = genderSelect ? genderSelect.value : 'Unspecified';
              const currentStatus = statusTextInput ? statusTextInput.value : '';
              
              const greeting = generateGreeting({
                name: currentName,
                gender: currentGender,
                status: currentStatus
              });
              
              const success = sendDataChannelMessage({
                type: 'greeting',
                name: currentName,
                gender: currentGender,
                status: currentStatus,
                avatar: sessionStorage.getItem('avatar') || '',
                content: greeting
              });
              
              if (success) {
                addGreetingMessage(currentName, greeting, sessionStorage.getItem('avatar') || '', true);
              }
            }, 1000);
          }
          break;
          
        case 'greeting':
          if (data.name && data.content) {
            addGreetingMessage(data.name, data.content, data.avatar, false);
            
            showNotification(
              `${data.name} says hello!`, 
              data.content,
              'message'
            );
          }
          break;
          
        case