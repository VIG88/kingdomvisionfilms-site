/* ═══════════════════════════════════════════════════════════════
   KINGDOM VISION FILMS — script.js
   Cinematic Engine v17 — Guaranteed Video Crossfade Edition

   ARCHITECTURE:
   ─────────────────────────────────────────────────────────────
   Phase 1 — INTRO
     • Intro video plays once (preload=auto, poster shown instantly)
     • canplaythrough gate ensures smooth playback before starting
     • 3 s hard timeout skips intro if nothing loads
     • At t=9.3 s → beginCrossfade()

   Phase 2 — CROSSFADE (1.8 s)
     • BG video A was preloading silently during intro (opacity:0)
     • BG video A is seeked to t=0 and CONFIRMED playing before
       the wrapper opacity transition starts — no black gap
     • intro-screen fades 1→0 while bg-video-wrap fades 0→1
       simultaneously over 1.8 s — no black in between

   Phase 3 — HOMEPAGE LOOP (dual-video seamless)
     • Video A plays. Video B mirrors it silently (same src, same t=0 start)
     • At (duration − 1.5 s): CSS crossfade A→B over 1.5 s
       Both videos show identical frames → transition invisible
     • After fade: outgoing video reset to t=0, plays silently
     • Alternates continuously — never pauses, never cuts

   FALLBACK (never black screen):
     • BG canplay timeout = 20 s (generous for CDN/mobile)
     • Fallback only fires if BOTH videos error AND canplay never fires
     • Fallback shows kvf-logo-4k.png static background
     • Even in fallback the wrapper is shown, not display:none

   SOUND:
     • isMuted shared across all 3 videos
     • First interaction auto-unmutes (browser autoplay policy)
     • Sound toggle persists through entire lifecycle
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Debug logger ───────────────────────────────────────────── */
  function kvfLog(msg, data) {
    var out = '[KVF] ' + msg;
    if (data !== undefined) { console.log(out, data); } else { console.log(out); }
  }
  kvfLog('script.js loaded — KVF Cinematic Engine v17');

  /* ── DOM references ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  var introScreen  = $('intro-screen');
  var introVideo   = $('intro-video');
  var introLoader  = $('intro-loader');
  var bgVideoWrap  = $('bg-video-wrap');
  var bgVideoA     = $('bg-video-a');
  var bgVideoB     = $('bg-video-b');
  var soundToggle  = $('sound-toggle');
  var iconMuted    = soundToggle ? soundToggle.querySelector('.icon-muted')   : null;
  var iconUnmuted  = soundToggle ? soundToggle.querySelector('.icon-unmuted') : null;
  var grainCanvas  = $('grain-canvas');
  var logoGlow     = $('logo-glow');
  var overlay      = $('cinematic-overlay');
  var vignette     = $('vignette');
  var pCanvas      = $('particle-canvas');
  var smokes       = document.querySelectorAll('.smoke');
  var siteHeader   = $('site-header');
  var words        = document.querySelectorAll('.word');
  var scrollCue    = $('scroll-cue');
  var navToggle    = $('nav-toggle');
  var mainNav      = $('main-nav');
  var heroTagline  = $('hero-tagline');

  /* ── Timing constants ───────────────────────────────────────── */
  var INTRO_FADE_SEC   = 9.3;     /* start crossfade at this intro time   */
  var INTRO_XFADE_MS   = 1800;    /* 1.8 s crossfade as required          */
  var STALL_TIMEOUT_MS = 3000;    /* 3 s hard timeout → skip intro        */
  var BG_CANPLAY_MS    = 20000;   /* 20 s before bg fallback fires        */
  /* NOTE: loop-swap timing is derived at runtime from the actual media
     duration (activeVid.duration) — never a hard-coded constant — so the
     R2 background video's real length drives the crossfade automatically. */
  var LOOP_XFADE_SEC   = 1.5;     /* seconds before end → start loop swap */
  var LOOP_XFADE_MS    = 1500;    /* must match CSS transition duration   */

  /* ── State ──────────────────────────────────────────────────── */
  var transitionStarted = false;
  var stallTimer        = null;
  var videoStarted      = false;
  var isMuted           = true;

  /* Dual-video loop state */
  var activeVid = bgVideoA;
  var idleVid   = bgVideoB;
  var swapping  = false;
  var loopRafId = null;

  /* BG readiness state */
  var bgAReady          = false;
  var bgBReady          = false;
  var bgFallbackApplied = false;
  var bgCanplayTimer    = null;
  var bgBothStarted     = false;  /* true once both bg videos are playing */
  var audioDucked       = false;  /* true while another experience (e.g. Mahogany
                                     Row) owns the audio — homepage stays silenced */


  /* ══════════════════════════════════════════════════════════════
     SOUND TOGGLE
  ══════════════════════════════════════════════════════════════ */
  function setSoundIcon(muted) {
    if (!iconMuted || !iconUnmuted) return;
    if (muted) {
      iconMuted.style.display   = '';
      iconUnmuted.style.display = 'none';
      soundToggle.setAttribute('aria-label', 'Sound Off — click to enable audio');
      soundToggle.setAttribute('title', 'Sound Off');
      soundToggle.classList.remove('unmuted');
    } else {
      iconMuted.style.display   = 'none';
      iconUnmuted.style.display = '';
      soundToggle.setAttribute('aria-label', 'Sound On — click to mute');
      soundToggle.setAttribute('title', 'Sound On');
      soundToggle.classList.add('unmuted');
    }
  }

  function applyMuteState(muted) {
    /* Before the transition, this governs the intro (initial state +
       first-interaction unmute). Once the intro is transitioning away, the
       homepage background video owns the audio, so we leave the intro muted
       here — its embedded track must never resume or overlap the handoff. */
    if (introVideo && !transitionStarted) { introVideo.muted = muted; introVideo.volume = muted ? 0 : 1; }
    /* Only the ACTIVE (visible) background video carries audio. The idle
       one is always kept muted so the two in-sync loop videos can never
       produce doubled/flanged audio during the dual-video crossfade. */
    if (activeVid) { activeVid.muted = muted; activeVid.volume = muted ? 0 : 1; }
    if (idleVid)   { idleVid.muted   = true;  idleVid.volume   = 0; }
  }

  /* ══════════════════════════════════════════════════════════════
     AUDIO OWNERSHIP HOOK
     Lets a separate experience (the Mahogany Row motion banner) take
     over as the ONLY audio source. Ducking pauses + mutes the homepage
     videos and halts the loop engine (so a loop swap can't re-unmute
     them); restoring resumes playback and the prior mute state. Exposed
     on window so the self-contained IN DEVELOPMENT module can call it
     without reaching into this engine's internals.
  ══════════════════════════════════════════════════════════════ */
  window.kvfDuckHomepageAudio = function (duck) {
    audioDucked = !!duck;
    if (audioDucked) {
      try { introVideo.pause(); } catch (e) {}
      try { bgVideoA.pause(); }  catch (e) {}
      try { bgVideoB.pause(); }  catch (e) {}
      [introVideo, bgVideoA, bgVideoB].forEach(function (v) {
        if (v) { v.muted = true; v.volume = 0; }
      });
      stopLoopEngine();
    } else {
      if (transitionStarted && !bgFallbackApplied) {
        bgVideoA.play().catch(function () {});
        bgVideoB.play().catch(function () {});
        startLoopEngine();
      }
      applyMuteState(isMuted);
    }
  };

  function showSoundToggle() {
    if (!soundToggle) return;
    soundToggle.classList.remove('hidden');
    setTimeout(function () { soundToggle.classList.add('visible'); }, 40);
  }

  if (soundToggle) {
    soundToggle.addEventListener('click', function () {
      isMuted = !isMuted;
      applyMuteState(isMuted);
      setSoundIcon(isMuted);
    });
  }

  setSoundIcon(true);
  applyMuteState(true);
  /* The intro attempts AUDIBLE autoplay of its embedded track, so it must not
     be pre-muted — otherwise the browser's autoplay would start it muted before
     tryPlayIntro runs, masking whether audible playback is actually allowed.
     (Background videos are muted independently during preload.) */
  if (introVideo) { introVideo.muted = false; introVideo.volume = 1; }


  /* ══════════════════════════════════════════════════════════════
     FIRST-INTERACTION AUTO-UNMUTE
     Browser autoplay policy: first user gesture unmutes everything.
  ══════════════════════════════════════════════════════════════ */
  var firstInteractionDone = false;

  function onFirstInteraction(e) {
    if (firstInteractionDone) return;
    if (soundToggle && soundToggle.contains(e.target)) return;
    firstInteractionDone = true;
    document.removeEventListener('click',     onFirstInteraction, true);
    document.removeEventListener('touchstart', onFirstInteraction, true);
    isMuted = false;
    applyMuteState(false);
    setSoundIcon(false);
  }

  document.addEventListener('click',     onFirstInteraction, true);
  document.addEventListener('touchstart', onFirstInteraction, { capture: true, passive: true });


  /* ══════════════════════════════════════════════════════════════
     BG VIDEO FALLBACK
     Only fires if canplay never arrives within 20 s OR both error.
     Shows static KVF image — never leaves a pure black screen.
     NOTE: we do NOT use display:none on bgVideoWrap — we replace
     the background with an image so overlays still render correctly.
  ══════════════════════════════════════════════════════════════ */
  function applyBgFallback() {
    if (bgFallbackApplied) return;
    bgFallbackApplied = true;
    kvfLog('BG fallback applied — showing static KVF image');

    clearTimeout(bgCanplayTimer);

    /* Stop videos */
    try { bgVideoA.pause(); bgVideoA.removeAttribute('src'); bgVideoA.load(); } catch (e) {}
    try { bgVideoB.pause(); bgVideoB.removeAttribute('src'); bgVideoB.load(); } catch (e) {}

    /* Replace video wrap background with static image — keep it visible */
    bgVideoWrap.style.background =
      'url(./assets/kvf-logo-4k.png) center center / cover no-repeat #000';

    /* Make sure the wrap is visible so the static image shows */
    bgVideoWrap.classList.add('visible');
  }

  /* ── BG canplay timeout — 20 s is generous enough for any network ── */
  bgCanplayTimer = setTimeout(function () {
    if (!bgFallbackApplied && !bgBothStarted) {
      kvfLog('BG canplay timeout — applying fallback');
      applyBgFallback();
    }
  }, BG_CANPLAY_MS);


  /* ══════════════════════════════════════════════════════════════
     BG VIDEO PRELOAD
     Both videos load silently during the intro. They do NOT play
     yet — we only confirm canplay so decoders are warm.
     Actual play() is called inside beginCrossfade() once we know
     the transition is about to happen. This ensures both videos
     are at t=0 and confirmed playing when the wrapper fades in.
  ══════════════════════════════════════════════════════════════ */
  bgVideoA.loop = true;
  bgVideoB.loop = true;

  /* Keep both muted during preload (required for autoplay) */
  bgVideoA.muted = true; bgVideoA.volume = 0;
  bgVideoB.muted = true; bgVideoB.volume = 0;

  bgVideoA.addEventListener('canplay', function onAReady() {
    bgVideoA.removeEventListener('canplay', onAReady);
    bgAReady = true;
    kvfLog('BG video A — canplay fired');
    /* Do NOT play yet — wait for crossfade trigger */
  });

  bgVideoB.addEventListener('canplay', function onBReady() {
    bgVideoB.removeEventListener('canplay', onBReady);
    bgBReady = true;
    kvfLog('BG video B — canplay fired');
  });

  var bgAErrored = false;
  var bgBErrored = false;

  bgVideoA.addEventListener('error', function () {
    bgAErrored = true;
    kvfLog('BG video A — error', bgVideoA.error ? bgVideoA.error.message : 'unknown');
    if (bgBErrored) applyBgFallback();
  }, { once: true });

  bgVideoB.addEventListener('error', function () {
    bgBErrored = true;
    kvfLog('BG video B — error', bgVideoB.error ? bgVideoB.error.message : 'unknown');
    if (bgAErrored) applyBgFallback();
  }, { once: true });

  /* Trigger preload — browsers load metadata + first segment */
  bgVideoA.load();
  bgVideoB.load();


  /* ══════════════════════════════════════════════════════════════
     DUAL-VIDEO SEAMLESS LOOP ENGINE
     Called AFTER both bg videos are confirmed playing.
     Watches activeVid.currentTime via rAF.
     At (duration − 1.5 s): crossfades A→B (or B→A).
     Both videos stay in sync → frames match → invisible blend.
  ══════════════════════════════════════════════════════════════ */
  function startLoopEngine() {
    if (loopRafId) return;
    if (bgFallbackApplied) return;

    /* Set correct initial CSS state */
    bgVideoA.classList.remove('bg-idle');
    bgVideoA.classList.add('bg-active');
    bgVideoB.classList.remove('bg-active');
    bgVideoB.classList.add('bg-idle');

    activeVid = bgVideoA;
    idleVid   = bgVideoB;

    kvfLog('Loop engine started');

    function tick() {
      loopRafId = requestAnimationFrame(tick);
      if (swapping) return;

      var ct  = activeVid.currentTime;
      var dur = activeVid.duration;

      if (!isFinite(dur) || dur < 0.5 || ct < 0.1) return;

      var swapAt = dur - LOOP_XFADE_SEC;
      if (swapAt < 0.1) swapAt = 0.1;
      if (ct < swapAt) return;

      /* ── BEGIN SWAP ─────────────────────────────────────── */
      swapping = true;
      kvfLog('Loop swap — ' + (activeVid === bgVideoA ? 'A→B' : 'B→A'));

      var incoming = idleVid;
      var outgoing = activeVid;

      /* Hand audio to the incoming (soon-visible) video and silence the
         outgoing one, so exactly one background track is ever audible.
         Both videos are in sync, so the hand-off is seamless AND doubled
         audio can never occur during the crossfade. */
      incoming.muted  = isMuted;
      incoming.volume = isMuted ? 0 : 1;
      incoming.play().catch(function () {});
      outgoing.muted  = true;
      outgoing.volume = 0;

      /* CSS crossfade — both at same currentTime → invisible blend */
      outgoing.classList.remove('bg-active');
      outgoing.classList.add('bg-idle');
      incoming.classList.remove('bg-idle');
      incoming.classList.add('bg-active');

      activeVid = incoming;
      idleVid   = outgoing;

      /* After CSS transition completes: reset outgoing to t=0 so it
         stays in sync for the next swap. Never seek while visible. */
      setTimeout(function () {
        outgoing.currentTime = 0;
        outgoing.play().catch(function () {});
        swapping = false;
      }, LOOP_XFADE_MS + 200);
    }

    loopRafId = requestAnimationFrame(tick);
  }

  function stopLoopEngine() {
    if (loopRafId) { cancelAnimationFrame(loopRafId); loopRafId = null; }
  }


  /* ══════════════════════════════════════════════════════════════
     STEP 1 — REVEAL HOMEPAGE LAYERS (runs immediately)
  ══════════════════════════════════════════════════════════════ */
  revealHomepage(0);

  /* ══════════════════════════════════════════════════════════════
     STEP 2 — FILM GRAIN (always running)
  ══════════════════════════════════════════════════════════════ */
  initGrain();


  /* ══════════════════════════════════════════════════════════════
     STEP 3 — INTRO VIDEO
     canplaythrough gate → smooth playback guaranteed.
     canplay fallback → 1 s grace period for fast connections.
     3 s global hard timeout → always reaches homepage.
  ══════════════════════════════════════════════════════════════ */
  var introCPTfired = false;
  var introStarted  = false;
  var reBuffering   = false;
  var cptFallback   = null;

  function tryPlayIntro() {
    if (transitionStarted) return;
    introStarted = true;
    introLoader.classList.add('hidden');
    introVideo.classList.add('playing');

    /* Attempt AUDIBLE autoplay of the intro's OWN embedded audio track —
       no separate soundtrack, just the MP4's own sound with audio enabled. */
    introVideo.muted = false;
    introVideo.volume = 1;
    var p = introVideo.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        /* Browser allowed audible autoplay → embedded intro audio is ON. */
        videoStarted = true;
        isMuted = false;
        setSoundIcon(false);
        kvfLog('Intro video playing — embedded audio ON');
      }).catch(function () {
        /* Browser blocked unmuted autoplay. Play the SAME video muted so the
           intro never fails — a policy fallback, NOT a saved preference. The
           already-armed first-interaction listener unmutes the embedded audio
           on the visitor's first click / tap / key press. */
        isMuted = true;
        introVideo.muted = true;
        introVideo.volume = 0;
        setSoundIcon(true);
        introVideo.play().then(function () {
          videoStarted = true;
          kvfLog('Intro video playing muted (autoplay policy) — awaiting first interaction');
        }).catch(function () {
          introVideo.classList.remove('playing');
        });
      });
    } else {
      videoStarted = true;
    }
  }

  introVideo.addEventListener('canplaythrough', function onCPT() {
    introVideo.removeEventListener('canplaythrough', onCPT);
    introCPTfired = true;
    kvfLog('Intro video — canplaythrough fired');
    clearTimeout(cptFallback);
    clearTimeout(stallTimer);

    if (reBuffering) {
      reBuffering = false;
      introVideo.play().catch(function () {});
      return;
    }
    if (!introStarted) {
      introLoader.classList.add('hidden');
      tryPlayIntro();
      setTimeout(showSoundToggle, 800);
    }
  });

  introVideo.addEventListener('canplay', function onCP() {
    introVideo.removeEventListener('canplay', onCP);
    kvfLog('Intro video — canplay fired');
    clearTimeout(stallTimer);
    introLoader.classList.add('hidden');

    if (!introCPTfired) {
      cptFallback = setTimeout(function () {
        if (!introCPTfired && !introStarted && !transitionStarted) {
          introCPTfired = true;
          tryPlayIntro();
          setTimeout(showSoundToggle, 800);
        }
      }, 1000);
    }
  });

  introVideo.addEventListener('loadeddata', function () {
    introLoader.classList.add('hidden');
  });

  introVideo.addEventListener('timeupdate', function () {
    if (transitionStarted) return;
    videoStarted = true;
    clearTimeout(stallTimer);
    if (introVideo.currentTime >= INTRO_FADE_SEC) {
      beginCrossfade();
    }
  });

  introVideo.addEventListener('ended', function () {
    if (!transitionStarted) beginCrossfade();
  }, { once: true });

  introVideo.addEventListener('error', function () {
    kvfLog('Intro video error — skipping', introVideo.error ? introVideo.error.message : '');
    skipIntro();
  }, { once: true });

  var sources    = introVideo.querySelectorAll('source');
  var lastSource = sources[sources.length - 1];
  if (lastSource) {
    lastSource.addEventListener('error', function () {
      if (!transitionStarted) skipIntro();
    }, { once: true });
  }

  introVideo.addEventListener('waiting', function () {
    if (!transitionStarted && introStarted) {
      reBuffering = true;
      introVideo.pause();
      resetStallTimer();
    }
  });

  introVideo.addEventListener('playing', function () {
    reBuffering = false;
    videoStarted = true;
    clearTimeout(stallTimer);
  });

  /* Hard 3 s global timeout */
  function resetStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (!transitionStarted) {
        kvfLog('Intro stall timeout — skipping to homepage');
        skipIntro();
      }
    }, STALL_TIMEOUT_MS);
  }
  resetStallTimer();

  /* Mobile autoplay wake */
  document.addEventListener('touchstart', function wakeVideo() {
    document.removeEventListener('touchstart', wakeVideo);
    if (transitionStarted) return;
    if (introVideo.paused && introStarted) {
      introVideo.play().catch(function () {});
    } else if (!introStarted && introCPTfired) {
      tryPlayIntro();
    }
  }, { passive: true });

  /* Tab visibility */
  document.addEventListener('visibilitychange', function () {
    if (audioDucked) return;   /* Mahogany Row owns audio/playback — leave homepage paused */
    if (document.hidden) {
      introVideo.pause();
      if (transitionStarted) {
        bgVideoA.pause();
        bgVideoB.pause();
        stopLoopEngine();
      }
    } else {
      if (!transitionStarted) {
        if (introStarted) introVideo.play().catch(function () {});
      } else {
        if (!bgFallbackApplied) {
          bgVideoA.play().catch(function () {});
          bgVideoB.play().catch(function () {});
          startLoopEngine();
        }
      }
    }
  });

  introVideo.load();


  /* ══════════════════════════════════════════════════════════════
     INTRO → BG CROSSFADE
     Critical sequence:
     1. Seek both bg videos to t=0
     2. Play both — wait for confirmed play on A
     3. Apply correct mute state
     4. THEN start the opacity transition (wrapper 0→1, intro 1→0)
     5. Start loop engine
     This guarantees video content is visible the moment the
     wrapper becomes opaque — zero black gap.
  ══════════════════════════════════════════════════════════════ */
  function executeCrossfade() {
    kvfLog('Crossfade executing — bg video starting');

    /* Apply current mute state */
    applyMuteState(isMuted);

    /* Seek both to t=0 for a clean start */
    try { bgVideoA.currentTime = 0; } catch (e) {}
    try { bgVideoB.currentTime = 0; } catch (e) {}

    /* Start A playing — confirmed via promise or fallback */
    var playPromise = bgVideoA.play();

    /* Runs exactly once. Guards against the play() promise and the safety
       timer both firing. */
    var crossfadeDone = false;

    function doFade() {
      if (crossfadeDone) return;
      crossfadeDone = true;
      clearTimeout(revealSafety);
      kvfLog('BG video A confirmed playing — starting opacity crossfade');
      bgBothStarted = true;
      clearTimeout(bgCanplayTimer);

      /* Start B playing silently in sync */
      bgVideoB.play().catch(function () {});

      /* Fire the opacity transitions simultaneously */
      introScreen.classList.add('fade-out');       /* intro: 1 → 0 */
      bgVideoWrap.classList.add('visible');         /* bg wrap: 0 → 1 */

      showSoundToggle();
      startLoopEngine();

      /* Clean up intro after transition */
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);

      document.body.classList.remove('intro-active');
    }

    /* Safety net — the R2 background video is remote, so a network error
       can leave bgVideoA.play() pending forever (no resolve, no reject,
       no error event). Never let the intro loader hang: if play() has not
       confirmed within a generous window (the bg has already been
       preloading throughout the intro), reveal the homepage over the
       existing static fallback image instead of a black screen. */
    var revealSafety = setTimeout(function () {
      if (crossfadeDone) return;
      crossfadeDone = true;
      kvfLog('BG video did not start in time — revealing homepage over static fallback');
      applyBgFallback();                             /* static KVF image  */
      introScreen.classList.add('fade-out');         /* intro: 1 → 0      */
      bgVideoWrap.classList.add('visible');          /* bg wrap: 0 → 1    */
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
    }, 6000);

    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(doFade).catch(function () {
        /* play() rejected — still do the fade, video may catch up */
        kvfLog('BG video A play() rejected — fading anyway');
        doFade();
      });
    } else {
      doFade();
    }
  }

  function beginCrossfade() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);
    kvfLog('beginCrossfade triggered at t=' + (introVideo.currentTime || 0).toFixed(2) + 's');

    /* Stop the intro's embedded audio the instant it starts transitioning out,
       so it can't overlap the homepage background video — a single audio source
       through the handoff. (applyMuteState now leaves the intro alone once
       transitionStarted, so this stays muted; the intro is paused shortly after.) */
    try { introVideo.muted = true; introVideo.volume = 0; } catch (e) {}

    if (bgFallbackApplied) {
      /* BG already in fallback state — just fade intro out */
      introScreen.classList.add('fade-out');
      bgVideoWrap.classList.add('visible');
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
      return;
    }

    if (bgAReady) {
      /* Decoder already warm — execute immediately */
      executeCrossfade();
    } else {
      /* Video still loading — wait up to 2 s for canplay, then go anyway */
      kvfLog('BG not ready yet — waiting for canplay (max 2s)');
      var waitTimer = setTimeout(function () {
        kvfLog('BG canplay wait expired — executing crossfade anyway');
        executeCrossfade();
      }, 2000);

      bgVideoA.addEventListener('canplay', function onBGReady() {
        bgVideoA.removeEventListener('canplay', onBGReady);
        clearTimeout(waitTimer);
        bgAReady = true;
        executeCrossfade();
      });
    }
  }

  function skipIntro() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);
    kvfLog('skipIntro — jumping to homepage');
    try { introVideo.pause(); } catch (e) {}

    if (bgFallbackApplied) {
      introScreen.classList.add('fade-out');
      bgVideoWrap.classList.add('visible');
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
      return;
    }

    executeCrossfade();
  }


  /* ══════════════════════════════════════════════════════════════
     HOMEPAGE REVEAL (layers fade in on page load)
  ══════════════════════════════════════════════════════════════ */
  function revealHomepage(d) {
    d = (typeof d === 'number') ? d : 0;

    after(d + 60,  function () {
      logoGlow.classList.add('visible');
      overlay.classList.add('visible');
    });
    after(d + 120, function () { vignette.classList.add('visible'); });
    after(d + 280, function () {
      smokes.forEach(function (s) { s.classList.add('visible'); });
    });
    after(d + 460, function () {
      pCanvas.classList.add('visible');
      initEmbers();
    });
    after(d + 700, function () { grainCanvas.classList.add('visible'); });
    after(d + 800, function () { siteHeader.classList.add('visible'); });
    words.forEach(function (w, i) {
      after(d + 1200 + i * 210, function () { w.classList.add('in'); });
    });
    var textEnd = d + 1200 + words.length * 210;
    after(textEnd + 520, function () { if (heroTagline) heroTagline.classList.add('in'); });
    after(textEnd + 860, function () { scrollCue.classList.add('in'); });
  }

  function after(ms, fn) { setTimeout(fn, Math.max(0, ms)); }


  /* ══════════════════════════════════════════════════════════════
     FILM GRAIN — warm-tinted noise canvas, ~20 fps
  ══════════════════════════════════════════════════════════════ */
  function initGrain() {
    if (!grainCanvas || grainCanvas._kvfGrain) return;
    grainCanvas._kvfGrain = true;

    var ctx = grainCanvas.getContext('2d');
    var W, H, imgData;

    function resize() {
      W = grainCanvas.width  = window.innerWidth;
      H = grainCanvas.height = window.innerHeight;
      imgData = ctx.createImageData(W, H);
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    var frame = 0;
    (function tickGrain() {
      frame++;
      if (frame % 3 === 0) {
        var data = imgData.data;
        for (var i = 0; i < data.length; i += 4) {
          var v    = (Math.random() * 255) | 0;
          data[i]  = v + 8;
          data[i+1]= v + 3;
          data[i+2]= v - 4;
          data[i+3]= 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      requestAnimationFrame(tickGrain);
    })();
  }


  /* ══════════════════════════════════════════════════════════════
     GOLD EMBER PARTICLE SYSTEM — 42 upward-drifting embers
  ══════════════════════════════════════════════════════════════ */
  function initEmbers() {
    if (pCanvas._kvfEmbers) return;
    pCanvas._kvfEmbers = true;

    var ctx = pCanvas.getContext('2d');
    var N   = 42;
    var W, H;

    function resize() {
      W = pCanvas.width  = window.innerWidth;
      H = pCanvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    function mkP(fromBottom) {
      var b = Math.random();
      return {
        x:   Math.random() * W,
        y:   fromBottom ? H + 12 : Math.random() * H,
        sz:  Math.random() * 2.2 + 0.3,
        vx:  (Math.random() - 0.5) * 0.20,
        vy:  -(Math.random() * 0.34 + 0.06),
        op:  Math.random() * 0.30 + 0.05,
        mop: Math.random() * 0.40 + 0.10,
        dir: Math.random() > 0.5 ? 1 : -1,
        spd: Math.random() * 0.003 + 0.001,
        r:   198 + Math.floor(b * 40),
        g:   150 + Math.floor(b * 58),
        b_:   38 + Math.floor(b * 46),
        life: 0,
        ml:  Math.random() * 800 + 200
      };
    }

    var P = [];
    for (var i = 0; i < N; i++) { P.push(mkP(false)); }

    (function tick() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < P.length; i++) {
        var p = P[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        p.op += p.spd * p.dir;
        if (p.op >= p.mop) { p.op = p.mop; p.dir = -1; }
        if (p.op <= 0.02)  { p.op = 0.02;  p.dir =  1; }
        if (p.y < -16 || p.x < -16 || p.x > W + 16 || p.life > p.ml) {
          P[i] = mkP(true); continue;
        }
        var rad = p.sz * 3.4;
        var g   = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, 'rgba('+p.r+','+p.g+','+p.b_+','+p.op+')');
        g.addColorStop(1, 'rgba('+p.r+','+p.g+','+p.b_+',0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.sz * 0.46, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba('+
          Math.min(p.r+30,255)+','+
          Math.min(p.g+22,255)+','+
          Math.min(p.b_+18,255)+','+
          Math.min(p.op*2.2,1)+')';
        ctx.fill();
      }
      requestAnimationFrame(tick);
    })();
  }


  /* ── Navigation ─────────────────────────────────────────────── */
  window.addEventListener('scroll', function () {
    siteHeader.classList.toggle('scrolled', window.scrollY > 50);
  }, { passive: true });

  navToggle.addEventListener('click', function () {
    var open = mainNav.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
  });

  mainNav.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      mainNav.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  /* In-page navigation (the four nav links + the hero scroll cue) is handled
     by the FIXED VIEW ROUTER at the end of this file: it switches the active
     full-screen view instead of scrolling the document, and routes every
     switch through the shared project-audio cleanup. No smooth-scroll here. */

})();


/* ═══════════════════════════════════════════════════════════════
   IN DEVELOPMENT — project experience controller (reusable)
   One controller per ACTIVE project slide (any .dev-slide whose
   .slate contains a .slate-video motion banner). Mahogany Row and
   Love Fever share this exact logic — no per-project special cases.
   Both projects embed their theme audio in the MP4 itself: the
   EXPLORE gesture drives a single unmuted video.play() attempt, with
   a muted fallback + subtle SOUND control if the browser blocks it.
   The homepage engine (window.kvfDuckHomepageAudio) and the slider
   (window.kvfSliderLock) provide site-wide audio isolation + freezing.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var section = document.getElementById('projects');
  if (!section) return;

  var mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() { return !!(mql && mql.matches); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var allSlides = [].slice.call(section.querySelectorAll('.dev-slide'));
  var projects  = [];

  /* Shared project-sound preference for the EXPANDED MOTION-PROJECT SLIDER:
     it carries across project-to-project transitions so the visitor never has
     to re-enable sound when the expanded slider advances. */
  var expSoundOn = false;

  function initProject(slate) {
    var video   = slate.querySelector('.slate-video');
    var explore = slate.querySelector('.slate-explore');  /* removed from markup — kept null-safe */
    if (!video) return null;                          /* an active project = a slide with a motion banner */
    var backBtn = slate.querySelector('.mr-back');        /* removed from markup — kept null-safe */
    var soundBtn= slate.querySelector('.mr-sound');
    var prevBtn = slate.querySelector('.mr-slidenav-prev');
    var nextBtn = slate.querySelector('.mr-slidenav-next');
    var prevEdge= slate.querySelector('.mr-edge-prev');
    var nextEdge= slate.querySelector('.mr-edge-next');
    var curEl   = slate.querySelector('.mr-slidenav-cur');
    var totEl   = slate.querySelector('.mr-slidenav-total');
    var controls= slate.querySelector('.mr-controls');
    var detail  = slate.querySelector('.slate-detail-wrap');
    var slide   = slate.closest('.dev-slide');

    var P = { opened: false, themeMuted: true, loadStarted: false, unmuteArmed: false,
              slideIndex: allSlides.indexOf(slide) };

    function warm() {
      if (P.loadStarted) return;
      try { if (video.preload === 'none') video.preload = 'metadata'; } catch (e) {}
    }
    function beginStreaming() {
      if (P.loadStarted) return;
      P.loadStarted = true;
      try { video.preload = 'auto'; } catch (e) {}
    }
    function reveal() { if (P.opened && !reducedMotion()) video.classList.add('is-playing'); }

    function updateSoundUI() {
      if (!soundBtn) return;
      soundBtn.classList.toggle('is-on', !P.themeMuted);
      soundBtn.classList.toggle('cue', P.themeMuted && P.opened);
      soundBtn.setAttribute('aria-pressed', String(!P.themeMuted));
      soundBtn.setAttribute('aria-label', P.themeMuted ? 'Enable theme music' : 'Mute theme music');
    }

    function onNextGesture(e) {
      if (soundBtn && soundBtn.contains(e.target)) return;
      if (backBtn && backBtn.contains(e.target)) return;
      if (prevBtn && prevBtn.contains(e.target)) return;
      if (nextBtn && nextBtn.contains(e.target)) return;
      if (prevEdge && prevEdge.contains(e.target)) return;
      if (nextEdge && nextEdge.contains(e.target)) return;
      disarm();
      if (P.opened) {
        expSoundOn = true;
        P.themeMuted = false; video.muted = false; video.volume = 1;
        if (video.paused) video.play().catch(function () {});
        reveal(); updateSoundUI();
      }
    }
    function arm() {
      if (P.unmuteArmed) return; P.unmuteArmed = true;
      document.addEventListener('pointerdown', onNextGesture, true);
      document.addEventListener('keydown',     onNextGesture, true);
    }
    function disarm() {
      if (!P.unmuteArmed) return; P.unmuteArmed = false;
      document.removeEventListener('pointerdown', onNextGesture, true);
      document.removeEventListener('keydown',     onNextGesture, true);
    }

    /* Activate this project's MEDIA (expand slate + play banner per the shared
       sound preference). Session-level audio isolation + key-art freeze are
       owned by the expanded slider (below), not here — so switching projects
       never churns the homepage duck / slider lock. */
    function activate() {
      P.opened = true;
      slate.classList.add('expanded');
      if (explore) explore.setAttribute('aria-expanded', 'true');

      /* Reduced motion → stay on the still key art, no motion, no audio */
      if (reducedMotion()) { P.themeMuted = true; updateSoundUI(); return; }

      beginStreaming();

      if (expSoundOn) {
        /* Sound preference ON → attempt AUDIBLE playback (allowed once the
           visitor's EXPLORE gesture has granted user activation). */
        video.muted = false; video.volume = 1;
        var pr = video.play();
        if (pr && typeof pr.then === 'function') {
          pr.then(function () {
            P.themeMuted = false; updateSoundUI(); reveal();
          }).catch(function () {
            /* Blocked → play muted, invite sound, unmute on the next gesture */
            P.themeMuted = true; video.muted = true; video.volume = 0; updateSoundUI();
            video.play().then(reveal).catch(function () { /* key art remains */ });
            arm();
          });
        } else {
          P.themeMuted = !!video.muted; updateSoundUI(); reveal();
        }
      } else {
        /* Sound preference OFF → play muted (no audible attempt, no cue-arm). */
        P.themeMuted = true; video.muted = true; video.volume = 0; updateSoundUI();
        video.play().then(reveal).catch(function () { /* key art remains */ });
      }
    }

    /* Deactivate this project's MEDIA (stop banner + its embedded audio, reset,
       collapse). Used both when the expanded slider moves on and on full exit. */
    function deactivate() {
      P.opened = false;
      slate.classList.remove('expanded');
      if (explore) explore.setAttribute('aria-expanded', 'false');
      disarm();

      video.classList.remove('is-playing');
      try { video.pause(); } catch (e) {}
      try { video.muted = true; video.volume = 0; } catch (e) {}
      try { video.currentTime = 0; } catch (e) {}   /* next open = fresh */
      P.themeMuted = true; updateSoundUI();
    }

    function toggleSound() {
      P.themeMuted = !P.themeMuted;
      expSoundOn = !P.themeMuted;                    /* carry the choice forward */
      video.muted = P.themeMuted; video.volume = P.themeMuted ? 0 : 1;
      if (!P.themeMuted) { disarm(); if (video.paused) video.play().catch(function () {}); reveal(); }
      updateSoundUI();
    }

    P.activate   = activate;
    P.deactivate = deactivate;
    P.warm       = warm;
    P.video = video; P.explore = explore; P.backBtn = backBtn;
    P.prevBtn = prevBtn; P.nextBtn = nextBtn;
    P.prevEdge = prevEdge; P.nextEdge = nextEdge;
    P.controls = controls; P.detail = detail;
    P.curEl = curEl; P.totEl = totEl;

    if (explore) { explore.addEventListener('pointerenter', warm); explore.addEventListener('focus', warm); }
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);
    video.addEventListener('loadeddata', reveal);
    video.addEventListener('playing',    reveal);
    video.addEventListener('error', function () { video.classList.remove('is-playing'); });

    return P;
  }

  /* Wire every active-project slide (a slide whose .slate has a motion banner) */
  [].forEach.call(section.querySelectorAll('.dev-slide .slate'), function (slate) {
    var p = initProject(slate);
    if (p) projects.push(p);
  });

  /* ══════════════════════════════════════════════════════════════
     EXPANDED MOTION-PROJECT SLIDER
     The second cinematic browsing layer. Selecting EXPLORE on any active
     project enters expanded mode; from there the active motion experiences
     (Mahogany Row → Love Fever → The Commandant's Own) auto-advance every 8s
     and can be moved manually / by swipe / by arrow keys. Each transition
     swaps the FULL project state together — video, embedded audio, title,
     category, synopsis, metadata, controls — with a clean single-source audio
     handoff, reusing the key-art slider's cross-dissolve (kvfSliderGoTo). The
     key-art slider itself stays frozen (locked) and returns to whatever
     project was last shown when the visitor exits.
     ══════════════════════════════════════════════════════════════ */
  /* Expanded projects DO NOT auto-advance. Once a viewer explores a project it
     stays open until they choose NEXT / PREVIOUS / ← / a global destination. The
     only timer here reveals the cinematic NEXT PROJECT control ~35s after a
     project opens (reset on every project change, cleared on exit / navigation).
     The motion banner keeps looping the whole time. */
  var REVEAL_MS = 35000;            /* NEXT PROJECT control reveal delay */
  var expIdx    = -1;               /* index into projects[]; -1 = not expanded */
  var revealTimer = null;

  /* Fixed position indicators (01 / 05, 02 / 05, …) — one per active project */
  projects.forEach(function (p, i) {
    if (p.curEl) p.curEl.textContent = pad2(i + 1);
    if (p.totEl) p.totEl.textContent = pad2(projects.length);
  });

  function nextIdx(i, dir) { var n = projects.length; return (i + dir + n) % n; }
  function warmNext() { if (expIdx < 0) return; var nx = projects[nextIdx(expIdx, 1)]; if (nx) nx.warm(); }

  /* NEXT PROJECT reveal — controls the edge control's opacity only; it never
     switches projects. Reduced motion skips the wait (there is no banner to sit
     through). */
  function revealClear() {
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    section.classList.remove('exp-ready');
  }
  function revealNow() { if (expIdx >= 0) section.classList.add('exp-ready'); }
  function revealStart() {
    revealClear();
    if (expIdx < 0) return;
    if (reducedMotion()) { revealNow(); return; }
    revealTimer = setTimeout(revealNow, REVEAL_MS);
  }

  function enterExpanded(P) {
    var i = projects.indexOf(P);
    if (i < 0) return;
    if (expIdx < 0) {
      /* Open the motion-project experience ONCE per IN DEVELOPMENT visit: isolate
         site audio + freeze the underlying slide engine. Kept out of activate()
         so switching projects never churns them. */
      if (window.kvfDuckHomepageAudio) { try { window.kvfDuckHomepageAudio(true); } catch (e) {} }
      if (window.kvfSliderLock)        { try { window.kvfSliderLock(true); } catch (e) {} }
      section.classList.add('expanded-mode');
      expSoundOn = true;   /* entering IN DEVELOPMENT is a nav gesture → attempt audible */
    } else if (projects[expIdx] && projects[expIdx] !== P) {
      projects[expIdx].deactivate();
    }
    expIdx = i;
    if (window.kvfSliderGoTo) { try { window.kvfSliderGoTo(P.slideIndex, 0); } catch (e) {} }
    P.activate();
    warmNext();
    if (P.backBtn) { try { P.backBtn.focus({ preventScroll: true }); } catch (e) {} }
    revealStart();
  }

  /* Move to the previous/next active project — full state swap + audio handoff. */
  function switchExp(dir) {
    if (expIdx < 0 || projects.length < 2) return;
    var from = projects[expIdx];
    var to   = projects[nextIdx(expIdx, dir)];
    if (!to || to === from) return;
    from.deactivate();                                   /* stop outgoing audio + video first */
    expIdx = projects.indexOf(to);
    if (window.kvfSliderGoTo) { try { window.kvfSliderGoTo(to.slideIndex, dir); } catch (e) {} }
    to.activate();                                       /* incoming becomes the only audio owner */
    warmNext();
    revealStart();                                       /* reset the NEXT reveal for the new project */
  }

  function exitExpanded() {
    if (expIdx < 0) return;
    revealClear();
    var cur = projects[expIdx];
    if (cur) cur.deactivate();
    expIdx = -1;
    section.classList.remove('expanded-mode');
    if (window.kvfDuckHomepageAudio) { try { window.kvfDuckHomepageAudio(false); } catch (e) {} }
    if (window.kvfSliderLock)        { try { window.kvfSliderLock(false); } catch (e) {} }
    /* Global navigation is the only way to leave IN DEVELOPMENT now; the view
       router lands focus on the destination view. (explore is null post-removal.) */
    if (cur && cur.explore) { try { cur.explore.focus({ preventScroll: true }); } catch (e) {} }
  }

  /* Single reusable media-stop path — exits the expanded slider entirely
     (stops the current banner + its audio, releases isolation, unfreezes the
     key-art slider, cancels the auto timer). Exposed for the nav router and
     every exit path so no project soundtrack survives leaving the section. */
  function closeAll() {
    if (expIdx >= 0) { exitExpanded(); }
    else { projects.forEach(function (p) { if (p.opened) p.deactivate(); }); }
  }
  window.kvfCloseActiveProjects = closeAll;

  /* IN DEVELOPMENT is now a single layer: entering the view opens the motion
     experience directly on the flagship (Mahogany Row, projects[0]) — no key-art
     browsing, no EXPLORE gate. The view router calls this after showing the view;
     it always cleans up first, so expIdx is -1 here and every fresh entry starts
     on Mahogany Row. The motion banner then plays per the current sound state. */
  function openDevExperience() {
    if (expIdx >= 0) return;               /* already open — leave the viewer where they are */
    if (!projects.length) return;
    enterExpanded(projects[0]);
  }
  window.kvfOpenDevExperience = openDevExperience;

  /* Wire each active project's EXPLORE / ← / ‹ / › + cinematic edge controls to
     the expanded slider. Manual only — no auto-advance to pause or resume. */
  projects.forEach(function (p) {
    if (p.explore)  p.explore.addEventListener('click', function () { enterExpanded(p); });
    if (p.backBtn)  p.backBtn.addEventListener('click', function () { exitExpanded(); });
    if (p.prevBtn)  p.prevBtn.addEventListener('click', function () { switchExp(-1); });
    if (p.nextBtn)  p.nextBtn.addEventListener('click', function () { switchExp(1);  });
    if (p.prevEdge) p.prevEdge.addEventListener('click', function () { switchExp(-1); });
    if (p.nextEdge) p.nextEdge.addEventListener('click', function () { switchExp(1);  });
  });

  /* Arrow keys move the expanded slider (and Esc exits) — always available, so a
     viewer is never trapped waiting on the 35s reveal. */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') { closeAll(); return; }
    if (expIdx < 0) return;
    if (e.key === 'ArrowLeft')  { switchExp(-1); }
    else if (e.key === 'ArrowRight') { switchExp(1); }
  });

  /* Mobile swipe between expanded projects (internal — no page scroll). */
  var devSlider = document.getElementById('dev-slider');
  if (devSlider) {
    var etsx = 0, etsy = 0, etouch = false;
    devSlider.addEventListener('touchstart', function (e) {
      if (expIdx < 0) return;
      var t = e.changedTouches[0]; etsx = t.clientX; etsy = t.clientY; etouch = true;
      if (nearEdge(t.clientX)) revealNow();       /* light tap near an edge reveals the control early */
    }, { passive: true });
    devSlider.addEventListener('touchend', function (e) {
      if (expIdx < 0 || !etouch) return; etouch = false;
      var t = e.changedTouches[0], dx = t.clientX - etsx, dy = t.clientY - etsy;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) { if (dx < 0) switchExp(1); else switchExp(-1); }
    }, { passive: true });
    /* Pointer nearing either frame edge reveals the control early (reveal only —
       it never switches projects). */
    devSlider.addEventListener('pointermove', function (e) {
      if (expIdx >= 0 && nearEdge(e.clientX)) revealNow();
    }, { passive: true });
  }

  /* True when a client-X sits within the outer ~18% band of the slider frame. */
  function nearEdge(clientX) {
    if (!devSlider) return false;
    var r = devSlider.getBoundingClientRect();
    if (!r.width) return false;
    var x = clientX - r.left;
    return x > r.width * 0.82 || x < r.width * 0.18;
  }

  /* Section-level exit safety net: if the whole IN DEVELOPMENT section
     leaves the viewport while project media is active — manual scroll-away,
     rapid or mobile navigation, an interrupted transition — stop it too, so
     cleanup never depends solely on how the visitor left. */
  if ('IntersectionObserver' in window) {
    var exitIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) closeAllProjects();
      });
    }, { threshold: 0 });
    exitIo.observe(section);
  }

  /* Soft cinematic entrance + warm the active banners as the section approaches */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          section.classList.add('in-view');
          projects.forEach(function (p) { p.warm(); });
          io.disconnect();
        }
      });
    }, { threshold: 0.12 });
    io.observe(section);
  } else {
    section.classList.add('in-view');
    projects.forEach(function (p) { p.warm(); });
  }
})();


/* ═══════════════════════════════════════════════════════════════
   IN DEVELOPMENT — cinematic project cross-dissolve engine
   One project visible at a time; Mahogany Row is slide 01 (flagship).
   This is NO LONGER a viewer-facing key-art browsing slider — the 8s
   auto-advance, chevron nav, counter, hover/focus/keyboard/swipe of the
   old key-art layer were removed when the motion-banner experience became
   the single IN DEVELOPMENT layer. What remains is the shared slide
   cross-dissolve (render/go), driven programmatically by the motion
   experience via kvfSliderGoTo as the viewer moves NEXT / PREVIOUS.
   Reduced motion → plain crossfade, no lateral drift.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var section = document.getElementById('projects');
  var slider  = document.getElementById('dev-slider');
  if (!section || !slider) return;
  var slides  = [].slice.call(slider.querySelectorAll('.dev-slide'));
  if (slides.length < 2) return;

  var mqlReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduce() { return !!(mqlReduce && mqlReduce.matches); }

  var idx = 0;
  var OFFSET = 46;        /* px of restrained lateral drift per transition */
  var pendingRaf = null;  /* guards the settle-frame against rapid navigation */

  function render(dir) {
    dir = dir || 0;
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = null; }

    slides.forEach(function (s, k) {
      s.setAttribute('aria-hidden', (k === idx) ? 'false' : 'true');
    });

    if (dir === 0 || reduce()) {
      /* Initial paint or reduced motion → straight crossfade, no lateral drift */
      slides.forEach(function (s, k) {
        s.style.transform = '';
        s.classList.toggle('is-active', k === idx);
      });
    } else {
      var incoming = slides[idx];
      /* Outgoing (currently active) slide drifts out opposite the travel dir
         while it fades — its transition is already live, so setting the target
         offset animates it. Every other slide rests centred and hidden. */
      slides.forEach(function (s, k) {
        if (k === idx) return;
        s.style.transform = s.classList.contains('is-active')
          ? 'translateX(' + (dir > 0 ? -OFFSET : OFFSET) + 'px)'
          : 'translateX(0)';
        s.classList.remove('is-active');
      });
      /* Incoming enters from the travel direction, then settles to centre —
         one project dominant at a time, slow lateral drift + opacity crossfade.
         The start offset is applied with the transition momentarily disabled
         (a FLIP) so it doesn't animate into place; the drift-to-centre then
         animates on the next frame while opacity crossfades via .is-active. */
      incoming.style.transition = 'none';
      incoming.style.transform = 'translateX(' + (dir > 0 ? OFFSET : -OFFSET) + 'px)';
      void incoming.offsetWidth;                   /* commit offset instantly  */
      incoming.style.transition = '';              /* restore CSS transitions  */
      incoming.classList.add('is-active');          /* opacity 0 → 1 crossfade  */
      pendingRaf = requestAnimationFrame(function () {
        pendingRaf = null;
        incoming.style.transform = 'translateX(0)'; /* drift 46px → centre      */
      });
    }
  }
  function go(i, dir) { idx = (i + slides.length) % slides.length; render(dir); }

  /* Freeze hook — kept for contract compatibility with the motion experience's
     enter/exit. Toggles the section state class only; there is no auto-advance
     to pause now that the key-art browsing layer is gone. */
  window.kvfSliderLock = function (l) {
    section.classList.toggle('slider-locked', !!l);
  };

  /* Programmatic slide jump — the motion-project experience drives this to
     cross-dissolve the visible slide to another project as the viewer moves
     NEXT / PREVIOUS. This is the only path into render() now. */
  window.kvfSliderGoTo = function (i, dir) {
    if (typeof i !== 'number') return;
    go(i, dir || 0);
  };

  render();
})();


/* ═══════════════════════════════════════════════════════════════
   FIXED VIEW ROUTER
   Navigation switches between full-screen view STATES (HOME / ABOUT /
   IN DEVELOPMENT / FILMS / CONTACT) with a ~600ms cross-dissolve — the
   document never scrolls to an anchor, so there is no page-level scrollbar.
   Every switch first runs the shared project-audio cleanup, so no project
   soundtrack can survive leaving a view. HOME is the default state, and
   re-selecting the section you're already in returns you HOME.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var body = document.body;

  var VIEWS = {
    about:    document.getElementById('about'),
    projects: document.getElementById('projects'),
    films:    document.getElementById('films'),
    contact:  document.getElementById('contact')
  };
  var navLinks = [].slice.call(document.querySelectorAll('#main-nav a[href^="#"]'));

  function nameFromHref(href) { return (href || '').replace(/^#/, ''); }

  function setActiveNav(view) {
    navLinks.forEach(function (a) {
      var on = nameFromHref(a.getAttribute('href')) === view;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page');
      else    a.removeAttribute('aria-current');
    });
  }

  function showView(view) {
    if (!VIEWS[view]) view = 'home';

    /* 1. Stop any open project experience + its audio before switching. */
    if (window.kvfCloseActiveProjects) {
      try { window.kvfCloseActiveProjects(); } catch (e) {}
    }

    /* 2. Toggle the section views (none active on HOME). */
    Object.keys(VIEWS).forEach(function (name) {
      var el = VIEWS[name];
      if (!el) return;
      var on = (name === view);
      el.classList.toggle('is-view-active', on);
      if (on) { try { el.scrollTop = 0; } catch (e) {} }
    });

    /* 3. Body state drives the HOME hero + footer visibility. */
    body.setAttribute('data-view', view);

    /* 4. Reflect the active section in the navigation. */
    setActiveNav(view === 'home' ? '' : view);

    /* 5. IN DEVELOPMENT opens directly into the motion-banner experience on the
          flagship (Mahogany Row) — no key-art browsing, no EXPLORE gate. Cleanup
          in step 1 already released any prior project, so this always starts fresh
          on Mahogany Row. Other views need nothing here. */
    if (view === 'projects' && window.kvfOpenDevExperience) {
      try { window.kvfOpenDevExperience(); } catch (e) {}
    }

    /* 6. Land keyboard focus inside the newly shown view. */
    if (view !== 'home' && VIEWS[view]) {
      var viewEl = VIEWS[view];
      try { viewEl.setAttribute('tabindex', '-1'); viewEl.focus({ preventScroll: true }); }
      catch (e) { try { viewEl.focus(); } catch (e2) {} }
    }
  }
  window.kvfShowView = showView;

  /* Nav links → switch view (re-selecting the active section returns HOME). */
  navLinks.forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var target  = nameFromHref(a.getAttribute('href'));
      var current = body.getAttribute('data-view');
      showView(current === target ? 'home' : target);
    });
  });

  /* Hero scroll cue → enter ABOUT. */
  var cue = document.getElementById('scroll-cue');
  if (cue) cue.addEventListener('click', function () { showView('about'); });

  /* Default state: HOME. */
  showView('home');
})();
