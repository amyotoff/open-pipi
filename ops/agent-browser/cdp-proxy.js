const http = require('http');
const net = require('net');

const targetHost = process.env.CDP_TARGET_HOST || '127.0.0.1';
const targetPort = Number(process.env.CDP_TARGET_PORT || 9223);
const listenHost = process.env.CDP_LISTEN_HOST || '0.0.0.0';
const listenPort = Number(process.env.CDP_LISTEN_PORT || 9222);

function publicWsBase(req) {
    return `ws://${req.headers.host || `localhost:${listenPort}`}`;
}

function rewriteCdpBody(req, body) {
    const publicBase = publicWsBase(req);
    return body
        .replaceAll(`ws://${targetHost}:${targetPort}`, publicBase)
        .replaceAll(`ws://127.0.0.1:${targetPort}`, publicBase)
        .replaceAll(`ws://localhost:${targetPort}`, publicBase);
}

function proxyHttp(req, res) {
    const headers = { ...req.headers, host: `${targetHost}:${targetPort}` };
    const upstream = http.request(
        {
            hostname: targetHost,
            port: targetPort,
            path: req.url,
            method: req.method,
            headers,
        },
        (upstreamRes) => {
            const responseHeaders = { ...upstreamRes.headers };
            const shouldRewrite = req.url?.startsWith('/json/version');

            if (!shouldRewrite) {
                res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
                upstreamRes.pipe(res);
                return;
            }

            const chunks = [];
            upstreamRes.on('data', (chunk) => chunks.push(chunk));
            upstreamRes.on('end', () => {
                const body = rewriteCdpBody(req, Buffer.concat(chunks).toString('utf8'));
                responseHeaders['content-length'] = Buffer.byteLength(body);
                delete responseHeaders['transfer-encoding'];
                res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
                res.end(body);
            });
        }
    );

    upstream.on('error', (error) => {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`CDP proxy error: ${error.message}`);
    });

    req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
    const upstream = net.connect(targetPort, targetHost, () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        for (const [key, value] of Object.entries({ ...req.headers, host: `${targetHost}:${targetPort}` })) {
            if (Array.isArray(value)) {
                for (const entry of value) upstream.write(`${key}: ${entry}\r\n`);
            } else if (value !== undefined) {
                upstream.write(`${key}: ${value}\r\n`);
            }
        }
        upstream.write('\r\n');
        if (head?.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on('upgrade', proxyUpgrade);
server.listen(listenPort, listenHost, () => {
    console.log(`[CDP_PROXY] Listening on ${listenHost}:${listenPort}, forwarding to ${targetHost}:${targetPort}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
