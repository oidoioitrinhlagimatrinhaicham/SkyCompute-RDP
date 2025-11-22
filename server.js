const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
// Phục vụ file tĩnh (index.html) từ thư mục hiện tại
app.use(express.static(path.join(__dirname)));

const GITHUB_API_URL = 'https://api.github.com';

// --- WORKFLOW CONFIGURATION ---
// Đã sửa lỗi: Dùng 'choco', 'Start-Process', tăng delay và echo Log đặc biệt
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
          # Cài đặt Ngrok bằng Chocolatey (có sẵn trên Runner)
          choco install ngrok -y
          ngrok authtoken \${{ secrets.NGROK_TOKEN }}
          
          # Chạy Ngrok trong nền bằng Start-Process để tránh treo shell
          Start-Process ngrok -ArgumentList "tcp 3389 --region \${{ github.event.inputs.region }}"
          
          # Đợi 30 giây để Ngrok khởi động ổn định và tạo tunnel
          Start-Sleep -Seconds 30
          
          # Lấy URL từ API nội bộ của Ngrok
          $ngrok_url = (iwr -Uri http://127.0.0.1:4040/api/tunnels).Content | ConvertFrom-Json | Select-Object -ExpandProperty tunnels | Select-Object -ExpandProperty public_url
          
          # Ghi URL vào biến môi trường và Log để Web bắt được
          echo "RDP_URL=$ngrok_url" | Out-File -FilePath $env:GITHUB_ENV -Append
          Write-Host ":::RDP_LINK::: $ngrok_url"
        shell: powershell

      - name: Configure RDP Credentials
        run: |
          # Tạo user và thêm vào nhóm Admin
          net user \${{ github.event.inputs.username }} \${{ github.event.inputs.password }} /add
          net localgroup administrators \${{ github.event.inputs.username }} /add
          # Mở firewall
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
// Mã hóa Base64 để gửi qua API
const WORKFLOW_BASE64 = Buffer.from(WORKFLOW_CONTENT).toString('base64');

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

// 1. Deploy (Tạo Repo & File)
app.post('/api/deploy', async (req, res) => {
    const { ghToken, repoName } = req.body;
    let logs = [];

    if (!ghToken || !repoName) return res.status(400).send({ message: 'Thiếu thông tin.' });

    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token GitHub không hợp lệ.' });
    logs.push({ type: 'success', message: `✔ Xác thực thành công: ${username}` });

    // Kiểm tra & Xóa Repo cũ
    const check = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}`);
    if (check.status === 200) {
        await callGitHub(ghToken, 'DELETE', `/repos/${username}/${repoName}`);
        logs.push({ type: 'warning', message: '⚠ Đã xóa Repository cũ trùng tên.' });
        await delay(2000); 
    }

    // Tạo Repo mới
    const create = await callGitHub(ghToken, 'POST', '/user/repos', { name: repoName, private: true, auto_init: false });
    if (create.status !== 201) return res.status(400).send({ message: 'Không thể tạo Repo.', logs });
    logs.push({ type: 'success', message: '✔ Repository mới đã được tạo.' });

    // Tạo README để khởi tạo nhánh main
    await callGitHub(ghToken, 'PUT', `/repos/${username}/${repoName}/contents/README.md`, {
        message: 'init', content: Buffer.from('# RDP Instance').toString('base64')
    });
    
    // Đợi nhánh main sẵn sàng
    await delay(2000);

    // Đẩy file Workflow
    await callGitHub(ghToken, 'PUT', `/repos/${username}/${repoName}/contents/.github/workflows/main.yml`, {
        message: 'Add workflow', content: WORKFLOW_BASE64
    });
    logs.push({ type: 'success', message: '✔ Đã nạp cấu hình Workflow.' });

    logs.push({ type: 'warning', message: '⚠ CHECKPOINT: Vui lòng thêm Secret NGROK_TOKEN trên GitHub.' });
    logs.push({ type: 'info', message: `🔗 https://github.com/${username}/${repoName}/settings/secrets/actions` });

    res.status(202).send({ logs });
});

// 2. Dispatch (Kích hoạt Actions)
app.post('/api/dispatch', async (req, res) => {
    const { ghToken, repoName, rdpPassword } = req.body;
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token Invalid' });

    const dispatch = await callGitHub(ghToken, 'POST', `/repos/${username}/${repoName}/actions/workflows/main.yml/dispatches`, {
        ref: 'main',
        inputs: { password: rdpPassword || 'P@sswordRDP!2025' }
    });

    if (dispatch.status !== 204) {
        return res.status(400).send({ message: `Lỗi kích hoạt: ${dispatch.status}`, logs: [] });
    }

    res.status(200).send({ logs: [{ type: 'success', message: '✔ Đã kích hoạt Workflow thành công!' }] });
});

// 3. Get Log (Lấy Link RDP)
app.post('/api/get-rdp-link', async (req, res) => {
    const { ghToken, repoName } = req.body;
    const username = await getUserLogin(ghToken);
    if (!username) return res.status(401).send({ message: 'Token Invalid' });

    const runs = await callGitHub(ghToken, 'GET', `/repos/${username}/${repoName}/actions/runs`);
    if (runs.status !== 200 || !runs.data.workflow_runs?.length) {
        return res.status(202).send({ message: 'Đang chờ Workflow khởi động...' });
    }

    const latestRun = runs.data.workflow_runs[0];
    
    const jobs = await axios.get(latestRun.jobs_url, { headers: { Authorization: `token ${ghToken}` } });
    if (!jobs.data.jobs?.length) return res.status(202).send({ message: 'Đang chờ Job...' });

    const rdpJob = jobs.data.jobs[0];

    try {
        const logRes = await axios.get(`${rdpJob.url}/logs`, { 
            headers: { Authorization: `token ${ghToken}` }, responseType: 'text' 
        });
        
        // Regex tìm link (tìm cả 2 định dạng cho chắc chắn)
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
