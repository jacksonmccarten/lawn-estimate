// The embed script of docs/ENGINEERING_DESIGN.md section 4:
//
//   <script src="https://widget.example.com/v1.js" data-company="joes-lawn" async></script>
//
// It puts one iframe where the script tag is, keeps the iframe as tall as its
// content, and tells the host's analytics when a request is sent. It reads
// and writes nothing else on the host page. No eval, no dependencies.
//
// Messages, all from the iframe's window at the widget origin and nowhere else:
//   lq:ready      the widget is listening; answered with lq:hello
//   lq:meta       {name} the company's name, for the iframe title
//   lq:resize     {height} the content height in CSS pixels
//   lq:focus      {top, bottom} of the focused control, relative to the iframe
//   lq:submitted  a lead was sent
// lq:hello goes the other way. Its origin, which the browser vouches for, is
// how the widget learns which site embeds it.
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script || !script.parentNode) return;

  // Same shape as the CHECK on companies.slug.
  var company = script.getAttribute("data-company") || "";
  if (company.length > 63 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(company)) return;

  var origin = __LQ_WIDGET_ORIGIN__ || new URL(script.src).origin;

  var frame = document.createElement("iframe");
  frame.src = origin + "/w/" + company;
  frame.title = "Instant lawn quote";
  frame.loading = "lazy";
  // Set through the CSSOM, which a host's style-src policy does not block.
  frame.style.display = "block";
  frame.style.width = "100%";
  frame.style.border = "0";
  frame.style.height = "520px";
  script.parentNode.insertBefore(frame, script.nextSibling);

  function hello() {
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: "lq:hello" }, origin);
  }
  // Whichever side is ready second starts the handshake.
  frame.addEventListener("load", hello);

  function finite(n) {
    return typeof n === "number" && isFinite(n);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data.type !== "string") return;

    if (data.type === "lq:ready") {
      hello();
    } else if (data.type === "lq:meta") {
      if (typeof data.name === "string" && data.name) {
        frame.title = "Instant lawn quote from " + data.name.slice(0, 120);
      }
    } else if (data.type === "lq:resize") {
      if (finite(data.height) && data.height > 0 && data.height < 20000) {
        frame.style.height = Math.ceil(data.height) + "px";
      }
    } else if (data.type === "lq:focus") {
      // WCAG 2.4.11: keep the focused control clear of the host's sticky
      // header by centering it when it is near an edge of the viewport.
      if (finite(data.top) && finite(data.bottom)) {
        var frameTop = frame.getBoundingClientRect().top;
        var top = frameTop + data.top;
        var bottom = frameTop + data.bottom;
        if (top < 96 || bottom > window.innerHeight - 16) {
          window.scrollBy(0, (top + bottom) / 2 - window.innerHeight / 2);
        }
      }
    } else if (data.type === "lq:submitted") {
      if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event: "lq:submitted", company: company });
    }
  });
})();
