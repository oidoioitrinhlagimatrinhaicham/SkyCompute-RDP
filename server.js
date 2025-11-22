const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();
const nacl = require('tweetnacl'); // THƯ VIỆN MÃ HÓA MỚI
nacl.util = require('tweetnacl-util'); // Cần cho Base64/UTF8

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const GITHUB_API_URL = 'https://api.github.com';

// --- WORKFLOW CONFIGURATION (Không đổi) ---
const WORKFLOW_CONTENT = `
name: Remote Desktop Connection

on: 
  workflow_dispatch:
    inputs:
      username:
        description: 'RDP Username'
        required: true
        default: 'rdpuser'
      password:
        description: 'RDP Password'
        required: true
        default: 'P@sswordRDP!2025'
      region:
        description: 'Ngrok Region (e.g., ap, us, eu)'
        required: true
        default: 'ap'

jobs:
  rdp_session:
    runs-on: windows-latest
    timeout-minutes: 360

    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Configure Ngrok Tunnel
        id: ngrok_setup
        run: |
          choco install ngrok -y
          ngrok authtoken \${{ secrets.NGROK_TOKEN }}
          Start-Process ngrok -ArgumentList "tcp 3389 --region \${{ github.event.inputs.region }}"
          Start-Sleep -Seconds 30
          $ngrok_url = (iwr -Uri http://127.0.0.1:4040/api/tunnels).Content | ConvertFrom-Json | Select-Object -ExpandProperty tunnels | Select-Object -ExpandProperty public_url
          echo "RDP_URL=$ngrok_url" | Out-File -FilePath $env:GITHUB_ENV -Append
          Write-Host ":::RDP_LINK::: $ngrok_url"
        shell: powershell

      - name: Configure RDP Credentials
        run: |
          net user \${{ github.event.inputs.username }} \${{ github.event.inputs.password }} /add
          net localgroup administrators \${{ github.event.inputs.username }} /add
          netsh advfirewall firewall set rule group="remote desktop" new enable=Yes

      - name: Display Connection Info
        run: |
          echo "====================================================="
          echo "✅ RDP Instance IS READY!"
          echo "RDP ADDRESS: \${{ env.RDP_URL }}"
          echo "Username: \${{ github.event.inputs.username }}"
          echo "Password: \${{ github.event.inputs.password }}"
          echo "====================================================="
        shell: bash

      - name: Keep Runner Alive
        run: |
          echo "RDP session is running. The runner will wait for 6 hours."
          Start-Sleep -Seconds 21600
        shell: powershell
`;
const WORKFLOW_BASE64 = Buffer.from(WORKFLOW_CONTENT).toString('base64');

// Mã hóa Secret bằng Public Key của GitHub
const encryptSecret = (publicKey, secretValue) => {
    // Chuyển Public Key và Secret từ Base64/UTF8 sang Uint8Array
    const key = nacl.util.decodeBase64(publicKey);
    const secret = nacl.util.decodeUTF8(secretValue);
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    // Mã hóa
    const encrypted = nacl.box.seal(secret, nonce, key, new Uint8Array(nacl.box.publicKeyLength));

    return {
        encrypted_value: nacl.util.encodeBase64(encrypted),
        key_id: nacl.util.encodeBase64(nonce)
    };
};


// --- HELPER FUNCTIONS ---

const callGitHub = async (token, method, endpoint, data = null) => {
    const url = `${GITHUB_API_URL}${endpoint}`;
    const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
    };
    try {
        const response = await axios({ method, url, headers, data });
        return { status: response.status, data: response.data };
    } catch (error) {
        return { status: error.response?.status || 500, error: error.response?.data || error.message };
    }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getUserLogin = async (token) => {
    const res = await callGitHub(token, 'GET', '/user');
    if (res.status !== 200) return null;
    return res.data.login;
};

// --- API ENDPOINTS ---

// 1. Deploy (Tạo Repo, Thêm Secret, và Dispatch)
const PORT = process.env.PORT || 3000;

app.post('/api/deploy', async (req, res) => {
    const { ghToken, ngrokToken, repoName } = req.body;
    let logs = [];

    if (!ghToken || !ngrokToken || !repoName) return res.status(400).send({ message: 'Thiếu Token hoặc Repo Name.' });

    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token GitHub không hợp lệ.' });
    logs.push({ type: 'success', message: `✔ Xác thực thành công: ${username}` });
    
    const repoPath = `/repos/${username}/${repoName}`;

    // 1. Kiểm tra & Xóa Repo cũ
    const check = await callGitHub(ghToken, 'GET', repoPath);
    if (check.status === 200) {
        await callGitHub(ghToken, 'DELETE', repoPath);
        logs.push({ type: 'warning', message: '⚠ Đã xóa Repository cũ trùng tên.' });
        await delay(2000); 
    }

    // 2. Tạo Repo mới
    const create = await callGitHub(ghToken, 'POST', '/user/repos', { name: repoName, private: true, auto_init: false });
    if (create.status !== 201) return res.status(400).send({ message: 'Không thể tạo Repo.', logs });
    logs.push({ type: 'success', message: '✔ Repository mới đã được tạo.' });

    // 3. Tạo README & Đẩy Workflow
    await callGitHub(ghToken, 'PUT', `${repoPath}/contents/README.md`, { message: 'init', content: Buffer.from('# RDP Instance').toString('base64') });
    await delay(2000);
    await callGitHub(ghToken, 'PUT', `${repoPath}/contents/.github/workflows/main.yml`, { message: 'Add workflow', content: WORKFLOW_BASE64 });
    logs.push({ type: 'success', message: '✔ Đã nạp cấu hình Workflow.' });

    // ********* 4. TỰ ĐỘNG THÊM SECRET *********
    logs.push({ type: 'info', message: '⚙ Đang tự động mã hóa và thêm Secret NGROK_TOKEN...' });

    // A. Lấy Public Key của Repo
    const keyRes = await callGitHub(ghToken, 'GET', `${repoPath}/actions/secrets/public-key`);
    if (keyRes.status !== 200) {
        logs.push({ type: 'error', message: '✖ Không thể lấy Public Key. Kiểm tra lại quyền Secret của Token.' });
        return res.status(400).send({ message: 'Lỗi lấy Public Key.', logs });
    }
    const { key_id, key } = keyRes.data;

    // B. Mã hóa Ngrok Token
    const encrypted = encryptSecret(key, ngrokToken);

    // C. Gửi Secret đã mã hóa lên GitHub
    const secretEndpoint = `${repoPath}/actions/secrets/NGROK_TOKEN`;
    const secretData = {
        encrypted_value: encrypted.encrypted_value,
        key_id: key_id
    };
    const addSecretRes = await callGitHub(ghToken, 'PUT', secretEndpoint, secretData);

    if (addSecretRes.status !== 201 && addSecretRes.status !== 204) {
        logs.push({ type: 'error', message: `✖ Lỗi thêm Secret (${addSecretRes.status}). Kiểm tra lại Ngrok Token.` });
        return res.status(400).send({ message: 'Lỗi thêm Secret.', logs });
    }

    logs.push({ type: 'success', message: '✔ Secret NGROK_TOKEN đã được thêm thành công!' });

    // ********* 5. TỰ ĐỘNG DISPATCH WORKFLOW *********
    logs.push({ type: 'info', message: '⚡ Tự động kích hoạt Actions...' });

    const dispatch = await callGitHub(ghToken, 'POST', `${repoPath}/actions/workflows/main.yml/dispatches`, {
        ref: 'main',
        inputs: { password: req.body.rdpPassword || 'P@sswordRDP!2025' }
    });

    if (dispatch.status !== 204) {
        logs.push({ type: 'error', message: '✖ Lỗi kích hoạt Workflow. (Lỗi 404/400).' });
        return res.status(400).send({ message: 'Lỗi kích hoạt Workflow.', logs });
    }

    logs.push({ type: 'success', message: '✔ Workflow đã khởi động! Bắt đầu quét Link...' });

    // Trả về thành công và chuyển ngay sang trạng thái Running
    res.status(200).send({ logs });
});


// 2. Dispatch (API này bị loại bỏ)
app.post('/api/dispatch', async (req, res) => {
    // API này không còn được dùng nữa, nhưng giữ lại để tránh lỗi Frontend
    res.status(400).send({ message: 'API này đã bị loại bỏ.' });
});


// 3. Get Log (Lấy Link RDP)
app.post('/api/get-rdp-link', async (req, res) => {
    const { ghToken, repoName } = req.body;
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token Invalid' });

    const runs = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}/actions/runs`);
    if (runs.status !== 200 || !runs.data.workflow_runs?.length) return res.status(202).send({ message: 'Đang chờ Workflow khởi động...' });

    const latestRun = runs.data.workflow_runs[0];
    
    const jobs = await axios.get(latestRun.jobs_url, { headers: { Authorization: `token ${ghToken}` } });
    if (!jobs.data.jobs?.length) return res.status(202).send({ message: 'Đang chờ Job...' });

    const rdpJob = jobs.data.jobs[0];

    try {
        const logRes = await axios.get(`${rdpJob.url}/logs`, { 
            headers: { Authorization: `token ${ghToken}` }, responseType: 'text' 
        });
        
        const logText = logRes.data;
        let match = logText.match(/:::RDP_LINK:::\s*(tcp:\/\/[\w\.-]+:\d+)/);
        if (!match) match = logText.match(/RDP ADDRESS:\s*(tcp:\/\/[\w\.-]+:\d+)/);

        if (match && match[1]) {
            return res.status(200).send({ rdpUrl: match[1] });
        }
    } catch (e) {
        // Log chưa có hoặc lỗi tải
    }

    return res.status(202).send({ message: 'Đang chờ Ngrok kết nối...' });
});

// 4. Delete
app.delete('/api/delete', async (req, res) => {
    const { ghToken, repoName } = req.body;
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({});
    const del = await callGitHub(ghToken, 'DELETE', `/repos/${username}/${repoName}`);
    res.status(del.status === 204 ? 200 : 400).send({});
});

// --- EXPORT CHO VERCEL & LOCAL RUN ---
module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
