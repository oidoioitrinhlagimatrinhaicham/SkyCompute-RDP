const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();
const nacl = require('tweetnacl');
nacl.util = require('tweetnacl-util');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const GITHUB_API_URL = 'https://api.github.com';

// WORKFLOW: Đã sửa scoop -> choco, fix lỗi syntax PowerShell
const WORKFLOW_CONTENT = `
name: Remote Desktop Connection
on: 
  workflow_dispatch:
    inputs:
      username: { description: 'User', required: true, default: 'rdpuser' }
      password: { description: 'Pass', required: true, default: 'P@sswordRDP!2025' }
      region: { description: 'Region', required: true, default: 'ap' }
jobs:
  rdp_session:
    runs-on: windows-latest
    timeout-minutes: 360
    steps:
      - uses: actions/checkout@v4
      - name: Setup Ngrok
        run: |
          choco install ngrok -y
          ngrok authtoken \${{ secrets.NGROK_TOKEN }}
          Start-Process ngrok -ArgumentList "tcp 3389 --region \${{ github.event.inputs.region }}"
          Start-Sleep -Seconds 30
          $url = (iwr -Uri http://127.0.0.1:4040/api/tunnels).Content | ConvertFrom-Json | Select-Object -ExpandProperty tunnels | Select-Object -ExpandProperty public_url
          echo "RDP_URL=$url" | Out-File -FilePath $env:GITHUB_ENV -Append
          Write-Host ":::RDP_LINK::: $url"
        shell: powershell
      - name: Create User
        run: |
          net user \${{ github.event.inputs.username }} \${{ github.event.inputs.password }} /add /Y
          net localgroup administrators \${{ github.event.inputs.username }} /add
          netsh advfirewall firewall set rule group="remote desktop" new enable=Yes
      - name: Keep Alive
        run: Start-Sleep -Seconds 21600
        shell: powershell
`;
const WORKFLOW_BASE64 = Buffer.from(WORKFLOW_CONTENT).toString('base64');

// HÀM MÃ HÓA SECRET (QUAN TRỌNG)
const encryptSecret = (publicKey, secretValue) => {
    const key = nacl.util.decodeBase64(publicKey);
    const secret = nacl.util.decodeUTF8(secretValue);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box.seal(secret, nonce, key, new Uint8Array(nacl.box.publicKeyLength));
    return {
        encrypted_value: nacl.util.encodeBase64(encrypted),
        key_id: nacl.util.encodeBase64(nonce)
    };
};

const callGitHub = async (token, method, url, data) => {
    try {
        return await axios({ method, url: `${GITHUB_API_URL}${url}`, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, data });
    } catch (e) { return { status: e.response?.status || 500, data: e.response?.data }; }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- API DEPLOY (TỰ ĐỘNG HOÀN TOÀN) ---
app.post('/api/deploy', async (req, res) => {
    const { ghToken, ngrokToken, repoName, rdpPassword } = req.body;
    let logs = [];

    if (!ghToken) return res.status(400).send({ message: 'Thiếu Token' });

    // 1. Lấy User
    const user = await callGitHub(ghToken, 'GET', '/user');
    if (user.status !== 200) return res.status(401).send({ message: 'Token sai hoặc hết hạn' });
    const username = user.data.login;
    logs.push({ type: 'success', message: `✔ User: ${username}` });

    const repoPath = `/repos/${username}/${repoName}`;

    // 2. Xóa Repo cũ
    const check = await callGitHub(ghToken, 'GET', repoPath);
    if (check.status === 200) {
        await callGitHub(ghToken, 'DELETE', repoPath);
        logs.push({ type: 'warning', message: '⚠ Đã xóa Repo cũ.' });
        await delay(2000);
    }

    // 3. Tạo Repo
    const create = await callGitHub(ghToken, 'POST', '/user/repos', { name: repoName, private: true, auto_init: false });
    if (create.status !== 201) return res.status(400).send({ message: 'Lỗi tạo Repo', logs });
    logs.push({ type: 'success', message: '✔ Repo mới đã tạo.' });

    // 4. Tạo File
    await callGitHub(ghToken, 'PUT', `${repoPath}/contents/README.md`, { message: 'init', content: Buffer.from('# RDP').toString('base64') });
    await delay(2000);
    await callGitHub(ghToken, 'PUT', `${repoPath}/contents/.github/workflows/main.yml`, { message: 'Add workflow', content: WORKFLOW_BASE64 });
    logs.push({ type: 'success', message: '✔ Đã nạp Workflow.' });

    // 5. AUTO ADD SECRET (TỰ ĐỘNG MÃ HÓA)
    logs.push({ type: 'info', message: '⚙ Đang mã hóa và thêm Secret...' });
    const keyRes = await callGitHub(ghToken, 'GET', `${repoPath}/actions/secrets/public-key`);
    if (keyRes.status !== 200) return res.status(400).send({ message: 'Lỗi lấy Public Key', logs });
    
    const encrypted = encryptSecret(keyRes.data.key, ngrokToken);
    await callGitHub(ghToken, 'PUT', `${repoPath}/actions/secrets/NGROK_TOKEN`, {
        encrypted_value: encrypted.encrypted_value,
        key_id: keyRes.data.key_id
    });
    logs.push({ type: 'success', message: '✔ Đã thêm Secret NGROK_TOKEN.' });

    // 6. DISPATCH (KÍCH HOẠT LUÔN)
    logs.push({ type: 'info', message: '⚡ Đang kích hoạt máy ảo...' });
    const dispatch = await callGitHub(ghToken, 'POST', `${repoPath}/actions/workflows/main.yml/dispatches`, {
        ref: 'main',
        inputs: { password: rdpPassword || 'P@sswordRDP!2025' }
    });

    if (dispatch.status !== 204) return res.status(400).send({ message: 'Lỗi kích hoạt', logs });
    
    logs.push({ type: 'success', message: '✔ Kích hoạt thành công! Đang chờ kết nối...' });
    res.status(200).send({ logs });
});

// API LẤY LINK
app.post('/api/get-rdp-link', async (req, res) => {
    const { ghToken, repoName } = req.body;
    const user = await callGitHub(ghToken, 'GET', '/user');
    if (user.status !== 200) return res.status(401).send({});
    const username = user.data.login;

    const runs = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}/actions/runs`);
    if (!runs.data?.workflow_runs?.[0]) return res.status(202).send({});

    const jobs = await axios.get(runs.data.workflow_runs[0].jobs_url, { headers: { Authorization: `token ${ghToken}` } });
    if (!jobs.data?.jobs?.[0]) return res.status(202).send({});

    try {
        const log = await axios.get(`${jobs.data.jobs[0].url}/logs`, { headers: { Authorization: `token ${ghToken}` }, responseType: 'text' });
        const match = log.data.match(/:::RDP_LINK:::\s*(tcp:\/\/[\w\.-]+:\d+)/);
        if (match) return res.status(200).send({ rdpUrl: match[1] });
    } catch (e) {}
    
    res.status(202).send({});
});

app.delete('/api/delete', async (req, res) => {
    const user = await callGitHub(req.body.ghToken, 'GET', '/user');
    await callGitHub(req.body.ghToken, 'DELETE', `/repos/${user.data.login}/${req.body.repoName}`);
    res.status(200).send({});
});

module.exports = app;
