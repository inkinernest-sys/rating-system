import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { google } from 'googleapis';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(cookieParser());

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/callback`
);

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.profile'];

// API Routes
app.get('/api/auth/url', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.json({ url });
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    // Store tokens in a secure cookie
    res.cookie('google_tokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/api/user', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    res.json(userInfo.data);
  } catch (error) {
    res.status(401).json({ error: 'Session expired' });
  }
});

app.get('/api/sheets/list', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { semester } = req.query;
  const SEMESTER_SHEETS: Record<string, string> = {
    "I семестр": "1llGOANdkTN6dCg9hJzZcIdrNwn0AR2LtBwyRIrbqbCs",
    "II семестр": "1Ss3Up9GYNvL8G3cF9uNiLWlaQUJlQiIL7mpcjixkKoU"
  };

  const spreadsheetId = SEMESTER_SHEETS[semester as string];
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Invalid semester' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    
    const sheetTitles = spreadsheet.data.sheets?.map(s => s.properties?.title).filter(Boolean) || [];
    res.json({ sheets: sheetTitles });
  } catch (error) {
    console.error('Error listing sheets:', error);
    res.status(500).json({ error: 'Failed to fetch sheets' });
  }
});

app.post('/api/sheets/export', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { data, semester, grade, studentName } = req.body;
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  // Map semester to specific spreadsheet IDs
  const SEMESTER_SHEETS: Record<string, string> = {
    "I семестр": "1llGOANdkTN6dCg9hJzZcIdrNwn0AR2LtBwyRIrbqbCs",
    "II семестр": "1Ss3Up9GYNvL8G3cF9uNiLWlaQUJlQiIL7mpcjixkKoU"
  };

  const spreadsheetId = SEMESTER_SHEETS[semester];
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Invalid semester selected' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // 1. Check if the sheet for the specific class exists, if not create it
    console.log('Accessing spreadsheet:', spreadsheetId);
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    console.log('Spreadsheet title:', spreadsheet.data.properties?.title);
    
    const sheetName = grade;
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === sheetName);
    console.log(`Sheet "${sheetName}" exists:`, sheetExists);

    if (!sheetExists) {
      console.log(`Creating sheet: ${sheetName}`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: sheetName }
            }
          }]
        }
      });
    }

    // 2. Get subjects (headers) from row 3, columns C-AH
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!C3:AH3`,
    });
    
    let headerSubjects = headerResponse.data.values ? headerResponse.data.values[0] : [];
    
    // If headers are missing or mismatched, update the sheet with subjects from the data.
    // We always want to ensure row 3 matches the subjects we have.
    const subjects = data.map((item: any) => item.subject).filter(Boolean);
    
    console.log(`Updating headers in row 3 with subjects:`, subjects);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!C3`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [subjects],
      },
    });

    // 3. Find the student row or the first empty row
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!B4:B500`,
    });

    const values = response.data.values || [];
    // Normalize for comparison: lowercase, trim, remove extra spaces
    const normalizedTargetName = String(studentName).toLowerCase().trim().replace(/\s+/g, ' ');
    
    let rowIndex = values.findIndex(row => {
      if (!row[0]) return false;
      const normalizedRowName = String(row[0]).toLowerCase().trim().replace(/\s+/g, ' ');
      return normalizedRowName === normalizedTargetName;
    });

    let targetRow;
    if (rowIndex !== -1) {
      targetRow = rowIndex + 4;
      console.log(`Student "${studentName}" found at row ${targetRow}. Updating existing row.`);
    } else {
      let firstEmptyIndex = values.findIndex(row => !row || !row[0] || String(row[0]).trim() === "");
      if (firstEmptyIndex === -1) firstEmptyIndex = values.length;
      targetRow = firstEmptyIndex + 4;
      console.log(`Student "${studentName}" not found. Using first empty row ${targetRow}.`);
      
      // Write the student name since it's a new row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!B${targetRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[String(studentName || "").trim()]],
        },
      });
    }

    // 5. Write grades to Columns C-AH in the SAME row
    console.log(`Preparing grades for semester: "${semester}"`);
    const gradesRow = subjects.map(subject => {
      const normalizedSubject = subject.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\sа-яіїєґ()]/gi, '');
      
      const item = data.find((d: any) => {
        if (!d.subject) return false;
        const dSubject = d.subject.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\sа-яіїєґ()]/gi, '');
        
        // 1. Exact match is always best
        if (dSubject === normalizedSubject) return true;
        
        // 2. Special handling for Physical Education and its variants
        const isPhysEd = (s: string) => s.includes("фізична культура") || s.includes("фіз.культура") || s.includes("фіз культура");
        
        if (isPhysEd(normalizedSubject) || isPhysEd(dSubject)) {
          // Both must be Physical Education variants
          if (!(isPhysEd(normalizedSubject) && isPhysEd(dSubject))) return false;
          
          // Check for specific variants in parentheses
          const getVariant = (s: string) => {
            if (s.includes("хореографія")) return "choreo";
            if (s.includes("плавання")) return "swim";
            return "base";
          };
          
          const variant1 = getVariant(normalizedSubject);
          const variant2 = getVariant(dSubject);
          
          // If one is base and other is swim/choreo, it might be a mismatch, 
          // BUT if the base subject IS "Фізична культура" and the other includes "(плавання)", 
          // we need to be careful if we should match or not.
          // Based on the issue, "Фізична культура (плавання)" should match "Фізична культура (плавання)".
          
          return variant1 === variant2;
        }

        // 3. General partial match for other subjects
        const isPartialMatch = dSubject.includes(normalizedSubject) || normalizedSubject.includes(dSubject);
        if (isPartialMatch) {
          const lengthDiff = Math.abs(dSubject.length - normalizedSubject.length);
          // Only allow if the difference is very small (e.g., minor typo or extra space)
          if (lengthDiff < 3) return true;
        }
        
        return false;
      });
      
      if (!item) {
        console.log(`Subject not matched: "${subject}"`);
        return "";
      }
      
      // Map semester selection to the correct field. 
      // Map semester selection to the correct field. 
      const isSecondSemester = semester.includes("II") || semester.startsWith("II");
      let gradeVal = isSecondSemester ? (item.sem2 || "") : (item.sem1 || "");
      
      const sanitized = String(gradeVal).toLowerCase().trim();
      if (sanitized === "null" || sanitized === "undefined" || sanitized === "-" || sanitized === "") {
        return "";
      }
      return gradeVal;
    });

    if (gradesRow.length > 0) {
      console.log(`Writing grades to row ${targetRow}:`, gradesRow);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!C${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [gradesRow],
        },
      });
    }

    console.log(`Student name and grades written to row ${targetRow}`);

    res.json({ success: true, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=0` });
  } catch (error) {
    console.error('API ERROR (sheets/export):', error instanceof Error ? error.stack : error);
    res.status(500).json({ error: 'Failed to export to Google Sheets. ' + (error instanceof Error ? error.message : 'Unknown error') });
  }
});

app.post('/api/sheets/check-social', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { studentName, semester, grade } = req.body;
  
  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    
    // Check semester
    const sheetName = semester === "I семестр" ? "I сем" : "II сем";
    
    // ... логика проверки existing...
    res.json({ exists: false, hasSocialData: false });
  } catch (error) {
    console.error('API ERROR (sheets/check-social):', error instanceof Error ? error.stack : error);
    res.status(500).json({ error: 'Failed to check social: ' + (error instanceof Error ? error.message : 'Unknown error') });
  }
});

app.get('/api/sheets/list', async (req, res) => {
  try {
    // ... existing logic ...
    res.json({ sheets: [] });
  } catch (error) {
    console.error('API ERROR (sheets/list):', error instanceof Error ? error.stack : error);
    res.status(500).json({ error: 'Failed to list sheets: ' + (error instanceof Error ? error.message : 'Unknown error') });
  }
});

app.post('/api/sheets/check-student', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { studentName, semester, grade } = req.body;
  
  const SEMESTER_SHEETS: Record<string, string> = {
    "I семестр": "1llGOANdkTN6dCg9hJzZcIdrNwn0AR2LtBwyRIrbqbCs",
    "II семестр": "1Ss3Up9GYNvL8G3cF9uNiLWlaQUJlQiIL7mpcjixkKoU"
  };

  const spreadsheetId = SEMESTER_SHEETS[semester];
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Invalid semester' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // 1. Find the row for the student
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${grade}'!B4:B500`,
    });
    
    const values = response.data.values || [];
    const normalizedTargetName = String(studentName).toLowerCase().trim().replace(/\s+/g, ' ');
    const rowIndex = values.findIndex(row => {
      if (!row[0]) return false;
      const normalizedRowName = String(row[0]).toLowerCase().trim().replace(/\s+/g, ' ');
      return normalizedRowName === normalizedTargetName;
    });
    
    if (rowIndex === -1) {
      return res.json({ exists: false });
    }
    
    const targetRow = rowIndex + 4;

    // 2. Check columns C-AH (grades) and CF-CJ (social work)
    const checkResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${grade}'!C${targetRow}:CJ${targetRow}`,
    });
    
    const rowData = checkResponse.data.values ? checkResponse.data.values[0] : [];
    
    // Check if grades (C-AH) exist - simplified check
    let gradesExist = false;
    for (let i = 0; i <= 31; i++) {
        if (rowData[i] && String(rowData[i]).trim() !== "") {
            gradesExist = true;
            break;
        }
    }

    // Check if social work (CF-CJ) exist
    const socialResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${grade}'!CF${targetRow}:CJ${targetRow}`,
    });
    const socialData = socialResponse.data.values ? socialResponse.data.values[0] : [];
    
    const hasSocialData = (socialData[0] && socialData[0].trim() !== "") || 
                          (socialData[2] && socialData[2].trim() !== "") || 
                          (socialData[3] && socialData[3].trim() !== "") || 
                          (socialData[4] && socialData[4].trim() !== "");

    res.json({ exists: gradesExist, hasSocialData: hasSocialData });
  } catch (error) {
    console.error('Error checking student status:', error);
    res.status(500).json({ error: 'Failed to check student status' });
  }
});

app.post('/api/sheets/export-social', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { studentName, semester, grade, data } = req.body;
  if (!studentName || !semester || !grade || !data) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  const SEMESTER_SHEETS: Record<string, string> = {
    "I семестр": "1llGOANdkTN6dCg9hJzZcIdrNwn0AR2LtBwyRIrbqbCs",
    "II семестр": "1Ss3Up9GYNvL8G3cF9uNiLWlaQUJlQiIL7mpcjixkKoU"
  };

  const spreadsheetId = SEMESTER_SHEETS[semester];
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Invalid semester' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // 1. Find the row for the student
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${grade}'!B4:B500`,
    });
    
    const values = response.data.values || [];
    console.log('Searching for student:', studentName);
    console.log('Available students:', values.map(v => v[0]));
    
    const normalizedTargetName = String(studentName).toLowerCase().trim().replace(/\s+/g, ' ');
    const rowIndex = values.findIndex(row => {
      if (!row[0]) return false;
      const normalizedRowName = String(row[0]).toLowerCase().trim().replace(/\s+/g, ' ');
      return normalizedRowName === normalizedTargetName;
    });
    
    if (rowIndex === -1) {
      console.log('Student not found:', studentName, 'Normalized:', normalizedTargetName);
      return res.status(404).json({ error: 'Учня не знайдено в таблиці. Спочатку завантажте табель.' });
    }
    
    const targetRow = rowIndex + 4;

    // 2. Write data to columns CF, CH, CI, CJ
    // CF: activity, CH: tasks, CI: behavior, CJ: remarks
    const updateValues = [
      [data.activity, "", data.tasks, data.behavior, data.remarks]
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${grade}'!CF${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: updateValues,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error exporting social work:', error);
    res.status(500).json({ error: 'Failed to export social work data' });
  }
});

app.get('/api/sheets/list-students', async (req, res) => {
  const tokensStr = req.cookies.google_tokens;
  if (!tokensStr) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { semester, grade } = req.query;
  if (!semester || !grade) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  const SEMESTER_SHEETS: Record<string, string> = {
    "I семестр": "1llGOANdkTN6dCg9hJzZcIdrNwn0AR2LtBwyRIrbqbCs",
    "II семестр": "1Ss3Up9GYNvL8G3cF9uNiLWlaQUJlQiIL7mpcjixkKoU"
  };

  const spreadsheetId = SEMESTER_SHEETS[semester as string];
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Invalid semester' });
  }

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // Get all student names (B4:B500) and data (C4:CJ500)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${grade}'!B4:CJ500`,
    });
    
    const rows = response.data.values || [];
    const students: string[] = [];

    for (const row of rows) {
      const name = row[0];
      if (!name) continue;

      // Check if grades (C-AH, indices 0-31) or social work (CF-CJ, indices 100-104) exist
      let hasData = false;
      // Grades
      for (let i = 1; i <= 32; i++) {
        if (row[i] && String(row[i]).trim() !== "") {
          hasData = true;
          break;
        }
      }
      // Social work
      if (!hasData) {
        for (let i = 100; i <= 104; i++) {
          if (row[i] && String(row[i]).trim() !== "") {
            hasData = true;
            break;
          }
        }
      }

      if (hasData) {
        students.push(String(name).trim());
      }
    }
    
    res.json({ students });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('google_tokens');
  res.json({ success: true });
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
