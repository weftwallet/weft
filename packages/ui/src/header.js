// The header's layout (header.css has its markup and styles). Plain script
// with no imports: Shell.astro and the docs' header inline it right after
// the header, and the explorer inlines it into its template at the same
// place, so it runs before the first paint. It runs once per page.
//
// 1. The links. They never scroll: this sets data-links on the bar to the
//    first layout in which they fit (header.css lists them), measuring
//    whenever the bar's width changes and once the fonts have loaded.
// 2. Reading order. The CSS places the header's items by their order, which
//    leaves focus and a screen reader following the markup. This puts the
//    bar's children in the order they are drawn, by row and then from the
//    start of the row. It never changes what is drawn: each item is placed
//    by its order, and items with the same order keep theirs. Anything the
//    bar holds that is not drawn in a row (hidden, or positioned, like a
//    note under a button) moves with the item before it.
// 3. Search on a phone. [data-shell-search-open] opens the field across
//    the bar (aria-controls), as a .reversible (motion.css), and puts focus
//    in it. Escape, the close button, a click outside it or focus leaving
//    it close it, and focus returns to the button where it was in the field.
// 4. The header's height, as --weft-head-height on <html>, for the scroll
//    padding that keeps an anchor clear of the sticky header (and, in the
//    docs, Starlight's --sl-nav-height). With a supporting row on a phone it
//    is the bar's alone: a jump leaves the row hidden.
// 5. The supporting row on a phone (header.css): the links on a row of
//    their own, or the header's .shell-row. It goes by the direction of
//    scrolling. Within the row's height of the top it is always shown. Past
//    that, once the page has moved 8px further down it leaves; 8px up and it
//    comes back. A jump (a link to an anchor, a change of the hash) is not a
//    direction: when it ends past the row's height the row is hidden, and
//    the next 8px up brings it back. A page that moves itself to keep what
//    is being read in place calls window.weftHeaderSkipScroll() right after,
//    so that move counts for nothing. Focus moving into the row brings it
//    back, and it stays while a menu or note opened from it is showing.
(function () {
  var root = document.documentElement;
  var bars = Array.prototype.slice.call(document.querySelectorAll(".shell-bar"));
  if (!bars.length || bars[0].hasAttribute("data-links")) return;

  function fit(bar) {
    var nav = bar.querySelector(":scope > .shell-nav");
    if (!nav || !nav.querySelector("a")) {
      bar.setAttribute("data-links", "none");
      return;
    }
    var menu = bar.getAttribute("data-links-menu");
    var states = menu && matchMedia(menu).matches ? ["inline", "menu"] : ["inline", "row"].concat(nav.querySelector(".shell-nav__short") ? ["short"] : [], ["wrap"]);
    for (var i = 0; i < states.length; i++) {
      bar.setAttribute("data-links", states[i]);
      if (states[i] === "menu" || states[i] === "wrap") return;
      if (nav.scrollWidth <= nav.clientWidth + 0.5) return;
    }
  }

  function arrange(bar) {
    // A dialog opened from the header (the docs' search) leaves the top
    // layer if it is moved, so nothing moves while one is open.
    if (bar.querySelector("dialog[open], .is-open")) return;
    var rtl = getComputedStyle(bar).direction === "rtl";
    var items = [];
    Array.prototype.forEach.call(bar.children, function (el) {
      var cs = getComputedStyle(el);
      var placed = cs.display !== "none" && cs.position !== "absolute" && cs.position !== "fixed";
      if (placed || !items.length) {
        var box = el.getBoundingClientRect();
        items.push({ els: [el], y: box.top + box.height / 2, x: rtl ? -box.right : box.left });
      } else {
        items[items.length - 1].els.push(el);
      }
    });
    // Rows: items whose middles are within 16px of the row's first.
    var byY = items.slice().sort(function (a, b) { return a.y - b.y; });
    var row = 0;
    var rowY = byY.length ? byY[0].y : 0;
    byY.forEach(function (item) {
      if (item.y - rowY > 16) {
        row += 1;
        rowY = item.y;
      }
      item.row = row;
    });
    var drawn = items.slice().sort(function (a, b) { return a.row - b.row || a.x - b.x; });
    if (drawn.every(function (item, i) { return item === items[i]; })) return;
    var focused = document.activeElement;
    drawn.forEach(function (item) {
      item.els.forEach(function (el) { bar.appendChild(el); });
    });
    if (focused && focused !== document.activeElement && bar.contains(focused)) focused.focus({ preventScroll: true });
  }

  // The supporting row ------------------------------------------------------
  var head = bars[0].closest(".shell-head");
  var phone = matchMedia("(max-width: 719px)");
  var STEP = 8;
  var row = null;
  var rowTop = 0;
  var rowHeight = 0;
  var hidden = false;
  var last = 0;
  var travel = 0;
  var jumping = false;
  var jumpTimer = 0;

  function position() {
    var max = Math.max(0, root.scrollHeight - innerHeight);
    return Math.min(Math.max(0, scrollY), max);
  }
  function findRow() {
    if (!head || !phone.matches) return null;
    var own = head.querySelector(":scope > .shell-row");
    if (own && own.getClientRects().length) return own;
    var bar = head.querySelector(":scope > .shell-bar");
    var links = bar && bar.getAttribute("data-links");
    if (links === "row" || links === "short" || links === "wrap") return bar.querySelector(":scope > .shell-nav");
    return null;
  }
  function hide(on) {
    if (on && row && row.querySelector(".is-open, [data-row-keep]:not([hidden])")) on = false;
    if (on === hidden) return;
    hidden = on;
    if (row) head.setAttribute("data-row", on ? "hidden" : "shown");
  }
  function measureRow() {
    row = findRow();
    if (!row) {
      if (head) {
        head.removeAttribute("data-row");
        head.style.removeProperty("--weft-row-height");
      }
      hidden = false;
      return;
    }
    // By offsets, which leave out the lift of a row that is hidden.
    rowTop = 0;
    for (var el = row; el && el !== head; el = el.offsetParent) rowTop += el.offsetTop;
    rowHeight = Math.max(0, head.clientHeight - rowTop);
    head.style.setProperty("--weft-row-height", rowHeight + "px");
    if (!head.hasAttribute("data-row")) {
      last = position();
      hidden = false;
      head.setAttribute("data-row", "shown");
      onScroll();
    }
  }
  function endJump() {
    jumping = false;
    clearTimeout(jumpTimer);
  }
  function onScroll() {
    var s = position();
    var moved = s - last;
    last = s;
    if (!row) return;
    if (s <= rowHeight) {
      travel = 0;
      hide(false);
      return;
    }
    if (jumping) {
      travel = 0;
      hide(true);
      // A smooth jump is many scroll events; it has ended once they stop.
      clearTimeout(jumpTimer);
      jumpTimer = setTimeout(endJump, 150);
      return;
    }
    if (!moved) return;
    if (moved > 0 !== travel > 0) travel = 0;
    travel += moved;
    if (travel >= STEP) hide(true);
    else if (travel <= -STEP) hide(false);
  }
  function startJump() {
    jumping = true;
    clearTimeout(jumpTimer);
    jumpTimer = setTimeout(endJump, 400);
  }
  if (head) {
    addEventListener("scroll", onScroll, { passive: true });
    if ("onscrollend" in window) addEventListener("scrollend", function () { if (jumping) endJump(); });
    // A link to a place on this page.
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a[href*='#']");
      if (!a || e.defaultPrevented || a.target) return;
      var url = new URL(a.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search && url.hash) startJump();
    });
    addEventListener("hashchange", function () {
      startJump();
      onScroll();
    });
    head.addEventListener("focusin", function (e) {
      if (row && row.contains(e.target)) {
        travel = 0;
        hide(false);
      }
    });
    window.weftHeaderSkipScroll = function () {
      last = position();
      travel = 0;
    };
    var follow = function () {
      measureRow();
      height();
    };
    if (phone.addEventListener) phone.addEventListener("change", follow);
  }

  function height() {
    var bar = bars[0];
    var head = bar.closest("header");
    var border = head ? parseFloat(getComputedStyle(head).borderBottomWidth) || 0 : 0;
    root.style.setProperty("--weft-head-height", (row ? rowTop : bar.offsetHeight) + border + "px");
  }

  function search(bar) {
    bar.querySelectorAll("[data-shell-search-open]").forEach(function (button) {
      var pop = document.getElementById(button.getAttribute("aria-controls"));
      if (!pop) return;
      var isOpen = function () {
        return button.getAttribute("aria-expanded") === "true";
      };
      var set = function (open, focusButton) {
        button.setAttribute("aria-expanded", String(open));
        pop.classList.toggle("is-open", open);
        if (open) {
          var input = pop.querySelector("input");
          if (input) input.focus();
        } else if (focusButton) button.focus();
      };
      button.addEventListener("click", function () {
        set(!isOpen());
      });
      var close = pop.querySelector("[data-shell-search-close]");
      if (close) close.addEventListener("click", function () { set(false, true); });
      pop.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && isOpen()) {
          e.preventDefault();
          set(false, true);
        }
      });
      pop.addEventListener("focusout", function (e) {
        if (isOpen() && e.relatedTarget && !pop.contains(e.relatedTarget) && e.relatedTarget !== button) set(false);
      });
      document.addEventListener("click", function (e) {
        if (isOpen() && !pop.contains(e.target) && !button.contains(e.target)) set(false);
      });
      // Wide enough for the field in the bar: the pop has gone with the button.
      bar.weftCloseSearch = function () {
        if (isOpen() && !button.offsetParent) set(false);
      };
    });
  }

  function layout(bar) {
    fit(bar);
    arrange(bar);
  }

  bars.forEach(function (bar) {
    search(bar);
    layout(bar);
    if (typeof ResizeObserver === "undefined") return;
    var width = bar.clientWidth;
    new ResizeObserver(function () {
      if (bar.clientWidth !== width) {
        width = bar.clientWidth;
        layout(bar);
        if (bar.weftCloseSearch) bar.weftCloseSearch();
      }
      measureRow();
      height();
    }).observe(bar);
  });
  measureRow();
  height();
  // The fonts change what the links need.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      bars.forEach(layout);
      measureRow();
      height();
    });
  }
})();
