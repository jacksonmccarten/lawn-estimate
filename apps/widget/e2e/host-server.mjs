// A stand-in for a lawn company's own website, for the embed tests. It is
// reached as http://<anything>.localhost:<port>, so one server plays several
// origins, all on loopback like the widget under test (a page on a public
// address may not load scripts from a loopback one).
//
//   /?company=<slug>&spacer=<px>   a page embedding the widget the documented way
//   /mallory                       a frame that posts forged widget messages to its parent

import { createServer } from "node:http";

const [port, widgetOrigin] = process.argv.slice(2);

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/mallory") {
    response.end(
      `<!doctype html><title>Mallory</title><script>parent.postMessage({type:"lq:resize",height:4000},"*");parent.postMessage({type:"lq:meta",name:"Mallory"},"*")</script>`,
    );
    return;
  }
  const company = escapeHtml(url.searchParams.get("company") ?? "joes-lawn");
  const spacer = Number(url.searchParams.get("spacer")) || 0;
  response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host page</title></head>
  <body style="margin:0">
    <main>
      <h1>A lawn company's own site</h1>
      <div style="height:${spacer}px"></div>
      <script src="${widgetOrigin}/v1.js" data-company="${company}" async></script>
    </main>
  </body>
</html>`);
}).listen(Number(port), "127.0.0.1");
