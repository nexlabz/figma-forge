/* ============================================================
   Figma Forge — site behaviour
   No dependencies. Every widget degrades to a readable static state.
   ============================================================ */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  /* ---------- theme ---------- */
  (function theme() {
    var btn = document.querySelector('.theme-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var now = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = now;
      btn.setAttribute('aria-label', now === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
      try { localStorage.setItem('ff-theme', now); } catch (e) { /* private mode */ }
    });
  })();

  /* ---------- copy chips ---------- */
  (function copy() {
    [].forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
      btn.addEventListener('click', function () {
        var src = document.getElementById(btn.getAttribute('data-copy'));
        if (!src) return;
        var text = src.textContent.split('\n')
          .map(function (l) { return l.replace(/^\s*\$\s?/, '').trim(); })
          .filter(Boolean).join('\n');
        var ok = function () {
          var was = btn.textContent;
          btn.textContent = 'copied';
          btn.dataset.ok = '1';
          window.setTimeout(function () { btn.textContent = was; btn.dataset.ok = ''; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(ok, function () { btn.textContent = 'select it'; });
        } else { btn.textContent = 'select it'; }
      });
    });
  })();

  /* ============================================================
     THE INSPECT WIDGET
     Hover the composition; selection chrome snaps to the node under the
     pointer and reports its REAL measured size. The layer tree is bound to
     the same nodes, both ways. Flattened output could not do this, which is
     the point the widget is making.
     ============================================================ */
  (function inspect() {
    var stage = document.getElementById('stage');
    if (!stage) return;

    var box = document.getElementById('selbox');
    var name = document.getElementById('selname');
    var dim = document.getElementById('seldim');
    var vline = document.getElementById('snapv');
    var hline = document.getElementById('snaph');
    var treeBtns = [].slice.call(document.querySelectorAll('.tree button'));
    var nodes = [].slice.call(stage.querySelectorAll('[data-layer]'));
    if (!box || !nodes.length) return;

    var userDriving = false;
    var current = null;

    function rectIn(el) {
      var s = stage.getBoundingClientRect();
      var r = el.getBoundingClientRect();
      return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
    }

    /* snap guides fire when an edge or centre lines up with a sibling's.
       1px, solid, and shown/hidden instantly — no transition, because
       instantaneity is what makes a snap read as a snap. */
    function snaps(el, r) {
      var tol = 2, vAt = null, hAt = null;
      nodes.forEach(function (other) {
        if (other === el) return;
        var o = rectIn(other);
        [[r.x, o.x], [r.x + r.w, o.x + o.w], [r.x + r.w / 2, o.x + o.w / 2]].forEach(function (p) {
          if (vAt === null && Math.abs(p[0] - p[1]) <= tol) vAt = Math.round(p[1]);
        });
        [[r.y, o.y], [r.y + r.h, o.y + o.h], [r.y + r.h / 2, o.y + o.h / 2]].forEach(function (p) {
          if (hAt === null && Math.abs(p[0] - p[1]) <= tol) hAt = Math.round(p[1]);
        });
      });
      if (vAt !== null) { vline.style.left = vAt + 'px'; vline.classList.add('on'); }
      else vline.classList.remove('on');
      if (hAt !== null) { hline.style.top = hAt + 'px'; hline.classList.add('on'); }
      else hline.classList.remove('on');
    }

    function show(el) {
      if (!el) return;
      current = el;
      var r = rectIn(el);
      box.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
      box.style.width = r.w + 'px';
      box.style.height = r.h + 'px';
      box.classList.add('on');
      name.textContent = el.getAttribute('data-layer');
      dim.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
      snaps(el, r);
      var key = el.getAttribute('data-layer');
      treeBtns.forEach(function (b) {
        b.classList.toggle('hot', b.getAttribute('data-target') === key);
      });
    }

    function hide() {
      box.classList.remove('on');
      vline.classList.remove('on');
      hline.classList.remove('on');
      treeBtns.forEach(function (b) { b.classList.remove('hot'); });
      current = null;
    }

    /* pointer → deepest matching node under the cursor */
    stage.addEventListener('pointermove', function (e) {
      userDriving = true;
      var hit = null;
      for (var i = nodes.length - 1; i >= 0; i--) {
        var r = nodes[i].getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          if (!hit || r.width * r.height < hit.r.width * hit.r.height) hit = { el: nodes[i], r: r };
        }
      }
      if (hit) show(hit.el); else hide();
    });
    stage.addEventListener('pointerleave', function () {
      userDriving = false;
      hide();
    });

    /* tree → canvas, the other direction */
    treeBtns.forEach(function (b) {
      var target = b.getAttribute('data-target');
      var el = nodes.filter(function (n) { return n.getAttribute('data-layer') === target; })[0];
      if (!el) return;
      var enter = function () { userDriving = true; show(el); };
      var leave = function () { userDriving = false; hide(); };
      b.addEventListener('pointerenter', enter);
      b.addEventListener('pointerleave', leave);
      b.addEventListener('focus', enter);
      b.addEventListener('blur', leave);
      b.addEventListener('click', function () { show(el); });
    });

    /* fill the tree's measured column with real numbers */
    treeBtns.forEach(function (b) {
      var out = b.querySelector('.wh');
      var target = b.getAttribute('data-target');
      var el = nodes.filter(function (n) { return n.getAttribute('data-layer') === target; })[0];
      if (out && el) {
        var sync = function () {
          var r = el.getBoundingClientRect();
          out.textContent = Math.round(r.width) + '×' + Math.round(r.height);
        };
        sync();
        if ('ResizeObserver' in window) new ResizeObserver(sync).observe(el);
      }
    });

    /* ---------- presence cursors ----------
       Two, not five. One is the visitor's own pointer, re-skinned and
       tracking at 0.1s linear. One is an "agent" that lags at 0.5s and
       works the file on its own — it travels to a layer, dwells, and
       causes a visible consequence, which is what actually guides the eye.
       Both aria-hidden and pointer-events:none. */
    var layer = document.getElementById('cursors');
    var you = document.getElementById('cur-you');
    var peer = document.getElementById('cur-peer');
    if (!layer || !you || !peer) return;

    if (!finePointer.matches) { layer.remove(); return; }

    stage.addEventListener('pointermove', function (e) {
      var s = stage.getBoundingClientRect();
      you.style.transform = 'translate(' + (e.clientX - s.left) + 'px,' + (e.clientY - s.top) + 'px)';
      you.style.opacity = '1';
    });
    stage.addEventListener('pointerleave', function () { you.style.opacity = '0'; });

    var order = nodes.filter(function (n) { return n.getAttribute('data-agent') === '1'; });
    if (!order.length) order = nodes.slice(0, 4);
    var idx = 0;

    /* the label hangs down-right of the glyph, so aim at the target's right
       edge and clamp inside the stage — otherwise it lands on the copy. */
    function aim(el) {
      var r = rectIn(el);
      var s = stage.getBoundingClientRect();
      var x = Math.min(r.x + r.w - 10, s.width - 92);
      var y = Math.min(r.y + r.h * 0.5, s.height - 46);
      return { x: Math.max(6, x), y: Math.max(6, y) };
    }

    function park() {
      var a = aim(order[0]);
      peer.style.transform = 'translate(' + a.x + 'px,' + a.y + 'px)';
      show(order[0]);
    }

    if (reduce.matches) { park(); return; }

    function step() {
      if (userDriving) { window.setTimeout(step, 900); return; }
      var el = order[idx % order.length];
      idx++;
      var a = aim(el);
      peer.style.transform = 'translate(' + a.x + 'px,' + a.y + 'px)';
      /* the consequence lands once the cursor has arrived */
      window.setTimeout(function () { if (!userDriving) show(el); }, 460);
      window.setTimeout(step, 2300);
    }
    window.setTimeout(step, 900);
  })();

  /* ---------- interface tabs ---------- */
  (function ifaces() {
    var tabs = [].slice.call(document.querySelectorAll('.iftab'));
    if (!tabs.length) return;
    var panels = [].slice.call(document.querySelectorAll('[data-ifpanel]'));

    function pick(key, btn) {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === btn)); });
      panels.forEach(function (p) { p.hidden = p.getAttribute('data-ifpanel') !== key; });
      if (key === 'cli') replay();
    }
    tabs.forEach(function (btn, i) {
      btn.addEventListener('click', function () { pick(btn.getAttribute('data-if'), btn); });
      btn.addEventListener('keydown', function (e) {
        var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1
              : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = tabs[(i + d + tabs.length) % tabs.length];
        n.focus();
        pick(n.getAttribute('data-if'), n);
      });
    });
  })();

  /* ---------- terminal replay ----------
     Types the command, then streams output. aria-hidden with a static
     fallback, and under reduced-motion it just prints the finished state. */
  var replay = (function () {
    var running = false;
    return function () {
      var out = document.getElementById('term-out');
      if (!out || running) return;
      var lines = [
        { t: '$ figma-forge url https://stripe.com --file aBcD1234', c: 'cmd' },
        { t: '  launching chrome  ·  viewport 1440×900', c: 'p' },
        { t: '  extracted 2,418 nodes  ·  61 assets  ·  4 fonts', c: 'p' },
        { t: '  translating  ·  312 frames  2,106 text  41 vector', c: 'p' },
        { t: '  built 7 sections into "stripe.com — desktop"', c: 'g' },
        { t: '  2 warnings: backdrop-filter dropped ×2', c: 'o' },
        { t: '  → figma.com/design/aBcD1234?node-id=12-2', c: 'c' }
      ];
      if (reduce.matches) {
        out.innerHTML = lines.map(function (l) {
          return '<span class="' + (l.c === 'cmd' ? '' : l.c) + '">' + esc(l.t) + '</span>';
        }).join('\n');
        return;
      }
      running = true;
      out.textContent = '';
      var li = 0, ci = 0;
      function tick() {
        if (li >= lines.length) { running = false; return; }
        var l = lines[li];
        if (li === 0) {
          /* type the command a character at a time */
          ci++;
          out.innerHTML = '<span>' + esc(l.t.slice(0, ci)) + '</span><span class="caret"></span>';
          if (ci >= l.t.length) { li++; ci = 0; window.setTimeout(tick, 420); }
          else window.setTimeout(tick, l.t[ci] === ' ' ? 54 : 26);
          return;
        }
        /* stream the rest a line at a time */
        var done = lines.slice(0, li).map(function (x, i) {
          return '<span class="' + (i === 0 ? '' : x.c) + '">' + esc(x.t) + '</span>';
        }).join('\n');
        out.innerHTML = done + '\n<span class="' + l.c + '">' + esc(l.t) + '</span>';
        li++;
        window.setTimeout(tick, li === lines.length ? 0 : 300);
      }
      tick();
    };
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  })();

  /* run the terminal when it first scrolls into view */
  (function termOnView() {
    var t = document.getElementById('term-out');
    if (!t) return;
    if (!('IntersectionObserver' in window)) { replay(); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { replay(); io.disconnect(); } });
    }, { threshold: 0.4 });
    io.observe(t);
  })();

  /* ---------- beta modal ----------
     Native <dialog>: focus trap, Esc and an inert background come from the
     platform. Closes on the X, on a backdrop click, or on Esc. Submitting
     resolves to one of three states, and only success auto-closes. */
  (function beta() {
    var dlg = document.getElementById('beta');
    if (!dlg) {
      /* other pages just link here */
      [].forEach.call(document.querySelectorAll('[data-open-beta]'), function (b) {
        b.addEventListener('click', function () { location.href = 'index.html#access'; });
      });
      return;
    }
    var form = document.getElementById('beta-form');
    var strip = document.getElementById('beta-status');
    var closing = null;

    var ICON = {
      ok:   '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M4 12.5l5.5 5.5L20 7"/></svg>',
      warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3L2 20h20L12 3z"/><path d="M12 9v5M12 17h.01"/></svg>',
      fail: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16h.01"/></svg>'
    };

    function state(kind, title, detail) {
      strip.className = 'status on ' + kind;
      strip.innerHTML = ICON[kind] + '<div><strong></strong><p></p></div>';
      strip.querySelector('strong').textContent = title;
      strip.querySelector('p').textContent = detail;
    }
    function clearState() { strip.className = 'status'; strip.textContent = ''; }

    function open() {
      clearState();
      form.hidden = false;
      form.reset();
      [].forEach.call(form.querySelectorAll('[aria-invalid]'), function (f) { f.removeAttribute('aria-invalid'); });
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
      var first = document.getElementById('f-name');
      if (first) first.focus();
    }
    function close() {
      if (closing) { window.clearTimeout(closing); closing = null; }
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }

    [].forEach.call(document.querySelectorAll('[data-open-beta]'), function (b) {
      b.addEventListener('click', open);
    });
    [].forEach.call(document.querySelectorAll('[data-close-beta]'), function (b) {
      b.addEventListener('click', close);
    });

    /* a backdrop click lands on the dialog element itself */
    dlg.addEventListener('click', function (e) { if (e.target === dlg) close(); });

    /* deep links from the other pages */
    if (location.hash === '#access') window.setTimeout(open, 60);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = form.elements.name;
      var email = form.elements.email;
      var bad = null;

      [name, email].forEach(function (f) { f.removeAttribute('aria-invalid'); });

      if (!name.value.trim()) bad = { f: name, t: 'Your name is missing', d: 'We only use it to say hello in the reply.' };
      else if (!email.value.trim()) bad = { f: email, t: 'Your email is missing', d: 'Without it there is no way to send you access.' };
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) bad = { f: email, t: 'That email looks off', d: 'Check it over — we only get one shot at reaching you.' };

      if (bad) {
        state('warn', bad.t, bad.d);
        bad.f.setAttribute('aria-invalid', 'true');
        bad.f.focus();
        return;
      }

      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      data.at = new Date().toISOString();

      try {
        var all = JSON.parse(localStorage.getItem('ff-beta') || '[]');
        all.push(data);
        localStorage.setItem('ff-beta', JSON.stringify(all));
      } catch (err) {
        state('fail', "Couldn't save your request", 'Browser storage is blocked, so this went nowhere. Send the same note by email instead.');
        return;
      }

      form.hidden = true;
      state('ok', "You're on the list", 'Saved. Nothing was transmitted — there is no server yet — so email us if you want a reply today.');
      closing = window.setTimeout(close, 2600);
    });
  })();

})();
