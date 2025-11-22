const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const GITHUB_API_URL = 'https://api.github.com';

// WORKFLOW: Giữ nguyên
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
          Start-Sleep -Seconds 15
          $url = (iwr -Uri http://127.0.0.1:4040/api/tunnels).Content | ConvertFrom-Json | Select-Object -ExpandProperty tunnels | Select-Object -ExpandProperty public_url
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

const callGitHub = async (token, method, url, data) => {
    try {
        return await axios({ method, url: `${GITHUB_API_URL}${url}`, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, data });
    } catch (e) { return { status: e.response?.status || 500, data: e.response?.data }; }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Lấy Username từ Token (Dynamic User)
const getUserLogin = async (token) => {
    const res = await callGitHub(token, 'GET', '/user');
    if (res.status !== 200) return null;
    return res.data.login; 
};

// API 1: DEPLOY
app.post('/api/deploy', async (req, res) => {
    const { ghToken, repoName } = req.body;
    let logs = [];
    if (!ghToken) return res.status(400).send({ message: 'Thiếu Token' });

    // 1. Tự động xác định User
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token không hợp lệ' });
    logs.push({ type: 'success', message: `✔ Xin chào, ${username}!` });

    // 2. Dùng username động để thao tác
    const check = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}`);
    if (check.status === 200) {
        await callGitHub(ghToken, 'DELETE', `/repos/${username}/${repoName}`);
        logs.push({ type: 'warning', message: '⚠ Đã dọn dẹp Repo cũ.' });
    }

    const create = await callGitHub(ghToken, 'POST', '/user/repos', { name: repoName, private: true, auto_init: false });
    if (create.status !== 201) return res.status(400).send({ message: 'Không thể tạo Repo', logs });
    logs.push({ type: 'success', message: '✔ Repo mới đã được khởi tạo.' });

    await callGitHub(ghToken, 'PUT', `/repos/${username}/${repoName}/contents/README.md`, { message: 'init', content: Buffer.from('# RDP').toString('base64') });
    await delay(2000);
    await callGitHub(ghToken, 'PUT', `/repos/${username}/${repoName}/contents/.github/workflows/main.yml`, { message: 'Add workflow', content: WORKFLOW_BASE64 });
    logs.push({ type: 'success', message: '✔ Đã nạp mã nguồn RDP Engine.' });

    logs.push({ type: 'warning', message: '⚠ CHECKPOINT: Thêm Secret NGROK_TOKEN trên GitHub ngay!' });
    logs.push({ type: 'info', message: `🔗 https://github.com/${username}/${repoName}/settings/secrets/actions` });

    res.status(202).send({ logs });
});

// API 2: DISPATCH
app.post('/api/dispatch', async (req, res) => {
    const { ghToken, repoName, rdpPassword } = req.body;
    
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token không hợp lệ' });

    const dispatch = await callGitHub(ghToken, 'POST', `/repos/${username}/${repoName}/actions/workflows/main.yml/dispatches`, { 
        ref: 'main', inputs: { password: rdpPassword || 'P@sswordRDP!2025' }
    });
    
    if (dispatch.status !== 204) return res.status(400).send({ message: `Lỗi kích hoạt: ${dispatch.status}`, logs: [] });
    res.status(200).send({ logs: [{ type: 'success', message: '✔ Đã gửi lệnh khởi động Runner.' }] });
});

// API 3: GET LOG
app.post('/api/get-rdp-link', async (req, res) => {
    const { ghToken, repoName } = req.body;
    
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token Invalid' });

    const runs = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}/actions/runs`);
    if (runs.status !== 200 || !runs.data.workflow_runs?.length) return res.status(404).send({ message: 'Waiting...' });
    
    const latestRun = runs.data.workflow_runs[0];
    const jobs = await axios.get(latestRun.jobs_url, { headers: { Authorization: `token ${ghToken}` } });
    
    if (!jobs.data.jobs?.length) return res.status(404).send({ message: 'Waiting job...' });

    try {
        const logResponse = await axios.get(`${jobs.data.jobs[0].url}/logs`, { 
            headers: { Authorization: `token ${ghToken}` }, responseType: 'text' 
        });
        const match = logResponse.data.match(/:::RDP_LINK:::\s*(tcp:\/\/[\w\.-]+:\d+)/);
        if (match && match[1]) return res.status(200).send({ rdpUrl: match[1] });
    } catch (e) {}

    return res.status(202).send({ message: 'Polling...' });
});

// API 4: DELETE
app.delete('/api/delete', async (req, res) => {
    const { ghToken, repoName } = req.body;
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({});
    
    const del = await callGitHub(ghToken, 'DELETE', `/repos/${username}/${repoName}`);
    res.status(del.status === 204 ? 200 : 400).send({});
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
