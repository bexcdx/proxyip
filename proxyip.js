const tls = require("node:tls")
const cluster = require("node:cluster")
const fs = require("node:fs")
const os = require("node:os")

const color = {
    gray: (text) => `\x1b[90m${text}\x1b[0m`,
    blue: (text) => `\x1b[34m${text}\x1b[0m`,
    cyan: (text) => `\x1b[36m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
    magenta: (text) => `\x1b[35m${text}\x1b[0m`,
};

function log(message, type = "info") {
    const timestamp = new Date().toISOString().split("T")[1].split(".")[0]
    const prefix = {
        info: color.blue("[INFO]"),
        success: color.green("[SUCCESS]"),
        error: color.red("[ERROR]"),
    }
    console.log(`${color.gray(timestamp)} ${prefix[type] || prefix.info} ${message}`)
}

const formatDuration = (ms) => {
    let totalSec = Math.floor(ms / 1000);
    let h = Math.floor(totalSec / 3600);
    let m = Math.floor((totalSec % 3600) / 60);
    let s = totalSec % 60;
    let f = [];
    if (h > 0) f.push(`${h}h`);
    if (m > 0) f.push(`${m}m`);
    if (s > 0 || f.length === 0) f.push(`${s}s`);
    return f.join(" ");
};

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length || 4
    const startTime = Date.now()
    let totalProxiesFound = 0
    let totalChecked = 0
    let completedWorkers = 0
    const jsonOutputFile = `proxyip.json`
    const proxyInputFile = `raw.json`
    const activeProxies = []
    const seen = new Set()
    let lastProgressUpdate = 0
    let totalProxies = 0

    function updateProgress() {
        const now = Date.now()
        if (now - lastProgressUpdate > 1000 || lastProgressUpdate === 0) {
            const pct = ((totalChecked / totalProxies) * 100).toFixed(1)
            const rate = totalChecked > 0 ? (totalChecked / ((now - startTime) / 1000)).toFixed(1) : '0'
            process.stdout.write(`\r${color.gray('[')}${color.cyan('PROGRESS')}${color.gray(']')} ${color.magenta(pct + '%')} (${color.cyan(`${totalChecked}/${totalProxies}`)}) | Found: ${color.green(totalProxiesFound)} | Rate: ${color.magenta(rate + '/s')}   `)
            lastProgressUpdate = now
        }
    }

    async function getMyIP() {
        const response = await fetch("https://speed.cloudflare.com/meta")
        if (!response.ok) throw new Error(`Failed to fetch IP: ${response.status}`)
        const data = await response.json()
        return data.clientIp
    }

    function loadProxies() {
        if (!fs.existsSync(proxyInputFile)) {
            log(`File ${proxyInputFile} not found!`, "error")
            process.exit(1)
        }
        const proxies = JSON.parse(fs.readFileSync(proxyInputFile, 'utf8'))
        return [...new Set((proxies).map(p => `${p.proxy}:${p.port}`))];
    }

    (async () => {
        try {
            const myip = await getMyIP()
            log(`Your IP: ${color.cyan(myip)}`, "info")

            const allProxies = loadProxies()
            totalProxies = allProxies.length
            log(`Loaded ${color.cyan(totalProxies)} proxies from ${proxyInputFile}`, "info")

            if (totalProxies === 0) {
                log("No proxies found!", "error")
                process.exit(1)
            }

            const chunks = []
            const chunkSize = Math.ceil(totalProxies / numCPUs)
            for (let i = 0; i < numCPUs; i++) {
                chunks.push(allProxies.slice(i * chunkSize, (i + 1) * chunkSize))
            }

            log(`Starting ${numCPUs} workers...`, "info")
     //       setInterval(() => fs.writeFileSync(jsonOutputFile, JSON.stringify(activeProxies, null, 2)), 60000)

            for (let i = 0; i < numCPUs; i++) {
                const worker = cluster.fork()

                worker.send({ myip, proxies: chunks[i] })

                worker.on("message", (msg) => {
                    if (msg.type === "proxyFound") {
                        const key = `${msg.data.proxy}:${msg.data.port}`
                        if (!seen.has(key)) {
                            seen.add(key)
                            totalProxiesFound++
                            activeProxies.push(msg.data)
                        }
                    //    process.stdout.clearLine(0)
                     //   process.stdout.cursorTo(0)
                      //  log(`Found: ${color.cyan(msg.data.proxy)}:${color.cyan(msg.data.port)} | ${color.yellow(msg.data.country || 'UNK')} | ${color.blue((msg.data.asOrganization || 'Unknown').substring(0, 30))} | ${color.cyan(msg.data.latency + 'ms')}`, "success")
                     //   updateProgress()
                    } else if (msg.type === "checked") {
                        totalChecked++
                      //  updateProgress()
                    }
                })

                worker.on('exit', () => {
                    completedWorkers++
                    if (completedWorkers === numCPUs) {
                        console.log()
                        fs.writeFileSync(jsonOutputFile, JSON.stringify(activeProxies, null, 2))
                        const duration = Date.now() - startTime
                        log(`Completed in ${formatDuration(duration)}`, "success")
                        log(`Checked: ${totalChecked}, Found: ${totalProxiesFound} working proxies`, "success")
                        log(`Results saved to ${jsonOutputFile}`, "success")
                        process.exit(0)
                    }
                })
            }

        } catch (error) {
            log(`${error.message}`, "error")
            process.exit(1)
        }
    })()

} else {
    let myip
    let proxies = []
    const CONCURRENCY = 50
    let idx = 0
    let running = 0
    let resolve

    process.on("message", async (msg) => {
        if (msg.myip && msg.proxies) {
            myip = msg.myip
            proxies = msg.proxies
            await new Promise(r => { resolve = r; runNext() })
            process.exit(0)
        }
    })

    function runNext() {
        while (running < CONCURRENCY && idx < proxies.length) {
            running++
            const p = proxies[idx++]
            checkProxy(p).finally(() => {
                running--
                if (idx < proxies.length) runNext()
                else if (running === 0) resolve()
            })
        }
    }

    async function sendRequest(host, port, targetHost, path) {
        return new Promise((resolve, reject) => {
            if (!host || !port) return reject(new Error("Missing host or port"))
            const start = Date.now()
            const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Timeout")) }, 5000)

            const socket = tls.connect({ host, port: parseInt(port), servername: targetHost }, () => {
                socket.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`)
            })

            let data = ""
            socket.on("data", c => data += c.toString())
            socket.on("end", () => {
                clearTimeout(timeout)
                const latency = Date.now() - start
                const parts = data.split("\r\n\r\n")
                const body = parts.length > 1 ? parts.slice(1).join("\r\n\r\n") : ""
                socket.destroy()
                resolve({ body, latency })
            })
            socket.on("error", e => { clearTimeout(timeout); socket.destroy(); reject(e) })
        })
    }

    async function checkProxy(proxy) {
        const [host, port] = proxy.split(':')
        try {
            const res = await sendRequest(host, port, "speed.cloudflare.com", "/meta")
            if (!res || !res.body) { process.send({ type: "checked" }); return }

            let info
            try { info = JSON.parse(res.body) } catch { process.send({ type: "checked" }); return }

            if (info.clientIp && info.clientIp !== myip && ["BAH", "CGP", "DAC", "JSR", "PBH", "BWN", "PNH", "HKG", "KHH", "MFM", "TPE", "TBS", "AMD", "BLR", "IXC", "MAA", "HYD", "CNN", "KNU", "COK", "CCU", "BOM", "NAG", "DEL", "PAT", "DPS", "CGK", "JOG", "BGW", "BSR", "EBL", "NJF", "XNH", "ISU", "TLV", "HFA", "FUK", "OKA", "KIX", "NRT", "AMM", "AKX", "ALA", "NQZ", "KWI", "FRU", "VTE", "JHB", "KUL", "KCH", "MLE", "ULN", "RGN", "KTM", "MCT", "ISB", "KHI", "LHE", "ZDM", "CGY", "CEB", "MNL", "CRK", "DOH", "DMM", "JED", "RUH", "SIN", "ICN", "CMB", "BKK", "CNX", "URT", "DXB", "TAS", "DAD", "HAN", "SGN"].includes(info.colo)) {
                const { clientIp: ip, httpProtocol, hostname, ...rest } = info
                process.send({ type: "proxyFound", data: { proxy: host, port, proxyip: true, ip, latency: res.latency, ...rest } })
            }
            process.send({ type: "checked" })
        } catch {
            process.send({ type: "checked" })
        }
    }
}
