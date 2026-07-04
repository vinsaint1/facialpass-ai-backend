const http = require('http');

const options = {
  hostname: '127.0.0.1',
  port: 5006,
  path: '/api/reports/monthly?monthPrefix=2026-07',
  method: 'GET',
  headers: {
    'x-admin-email': 'vinczokpa@gmail.com',
    'bypass-tunnel-reminder': 'true'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const j = JSON.parse(data);
      console.log('Success:', j.success);
      console.log('Summary:', JSON.stringify(j.summary, null, 2));
      console.log('Employee count:', j.employeeReport?.length);
      if (j.employeeReport) {
        j.employeeReport.forEach(e => console.log(`  ${e.name}: present=${e.presentDays}, absent=${e.absentDays}, late=${e.lateDays}, rate=${e.attendanceRate.toFixed(1)}%`));
      }
    } catch(e) {
      console.error('Parse error:', e.message);
      console.log('Raw:', data.substring(0, 500));
    }
  });
});

req.on('error', e => console.error('Request error:', e.message));
req.end();
