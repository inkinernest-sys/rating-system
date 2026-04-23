import React, { useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { FileText, LogOut, Loader2, FileSpreadsheet, ExternalLink, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { extractDataFromPDF } from '@/src/lib/gemini';
import { motion, AnimatePresence } from 'motion/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

interface User {
  id: string;
  name: string;
  picture: string;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [extractedData, setExtractedData] = useState<any[] | null>(null);
  const [studentName, setStudentName] = useState<string>('');
  const [summary, setSummary] = useState<string>('');
  const [user, setUser] = useState<User | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState<string | null>(null);
  const [isAlreadyProcessed, setIsAlreadyProcessed] = useState(false);
  const [classMismatchError, setClassMismatchError] = useState<string | null>(null);
  
  const [semester, setSemester] = useState<string>("I семестр");
  const [grade, setGrade] = useState<string>("5-А");
  const [availableGrades, setAvailableGrades] = useState<string[]>([]);
  const [isLoadingGrades, setIsLoadingGrades] = useState(false);

  const [socialWork, setSocialWork] = useState({
    activity: '',
    tasks: '',
    behavior: '',
    remarks: ''
  });

  const handleSocialWorkChange = (field: string, value: string, min: number, max: number) => {
    if (value === '') {
      setSocialWork(prev => ({ ...prev, [field]: '' }));
      return;
    }
    const numValue = parseInt(value);
    if (!isNaN(numValue) && numValue >= min && numValue <= max) {
      setSocialWork(prev => ({ ...prev, [field]: value }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, nextField?: string, prevField?: string) => {
    if (e.key === 'ArrowDown' && nextField) {
      const el = document.querySelector(`input[name="${nextField}"]`) as HTMLInputElement;
      el?.focus();
    } else if (e.key === 'ArrowUp' && prevField) {
      const el = document.querySelector(`input[name="${prevField}"]`) as HTMLInputElement;
      el?.focus();
    }
  };

  const handleSaveSocialWork = async () => {
    if (!studentName || !user) {
      toast.error('Учень не вибраний або Google не підключено');
      return;
    }

    setIsExporting(true);
    try {
      const res = await fetch('/api/sheets/export-social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName,
          semester,
          grade,
          data: {
            activity: socialWork.activity, // CF
            tasks: socialWork.tasks,       // CH
            behavior: socialWork.behavior, // CI
            remarks: socialWork.remarks ? `-${socialWork.remarks}` : '' // CJ (with minus)
          }
        })
      });

      if (res.ok) {
        toast.success('Дані Громадської роботи збережено!');
        setTimeout(() => {
          setFile(null);
          setExtractedData(null);
          setStudentName(null);
          setSummary(null);
          setSocialWork({ activity: '', tasks: '', behavior: '', remarks: '' });
          setIsAlreadyProcessed(false);
        }, 5000);
      } else {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Помилка збереження');
      }
    } catch (err) {
      console.error('Error saving social work:', err);
      toast.error(err instanceof Error ? err.message : 'Не вдалося зберегти дані');
    } finally {
      setIsExporting(false);
    }
  };

  useEffect(() => {
    fetchUser();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        fetchUser();
        toast.success('Успішно підключено до Google!');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (user) {
      fetchAvailableGrades();
    }
  }, [semester, user]);

  const fetchAvailableGrades = async () => {
    setIsLoadingGrades(true);
    try {
      const res = await fetch(`/api/sheets/list?semester=${encodeURIComponent(semester)}`);
      if (res.ok) {
        const data = await res.json();
        setAvailableGrades(data.sheets);
        if (data.sheets.length > 0 && !data.sheets.includes(grade)) {
          setGrade(data.sheets[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch grades:', err);
    } finally {
      setIsLoadingGrades(false);
    }
  };

  const fetchUser = async () => {
    try {
      const res = await fetch('/api/user');
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        setUser(null);
      }
    } catch (err) {
      setUser(null);
    }
  };

  const onDrop = (acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setExtractedData(null);
      setSpreadsheetUrl(null);
      setIsAlreadyProcessed(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false
  } as any);

  const handleProcess = async () => {
    if (!file) {
      toast.error('Будь ласка, виберіть файл');
      return;
    }

    setIsProcessing(true);
    setClassMismatchError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const result = await extractDataFromPDF(base64, file.type);
      console.log('Gemini extraction result:', result);
      
      // Check class name mismatch
      const normalizeClass = (name: string) => name.replace(/[A-Z]/g, (match) => {
        const map: { [key: string]: string } = { 'A': 'А', 'B': 'В', 'E': 'Е', 'K': 'К', 'M': 'М', 'H': 'Н', 'O': 'О', 'P': 'Р', 'C': 'С', 'T': 'Т', 'X': 'Х' };
        return map[match] || match;
      });
      
      const normalizedDetectedClass = normalizeClass(result.className);
      const normalizedSelectedClass = normalizeClass(grade);
      
      if (result.className && normalizedDetectedClass !== normalizedSelectedClass) {
        setClassMismatchError(`Табель не відповідає вибраному класу: розпізнано ${result.className}, а вибрано ${grade}`);
        setIsProcessing(false);
        return;
      }

      const extractedName = result.studentName || '';
      setExtractedData(result.data);
      setStudentName(extractedName);
      setSummary(result.summary || '');
      
      if (extractedName && user) {
        // Check if already processed
        try {
          const checkRes = await fetch('/api/sheets/check-social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              studentName: extractedName,
              semester,
              grade
            })
          });
          
          let checkData = { exists: false, hasSocialData: false };
          if (checkRes.ok) {
            checkData = await checkRes.json();
          }

          if (checkData.exists && checkData.hasSocialData) {
            setIsAlreadyProcessed(true);
            toast.warning('Такий учень вже повністю внесений');
          } else {
            setIsAlreadyProcessed(false);
            
            if (!checkData.exists) {
                toast.info('Автоматичний експорт оцінок...');
                setIsExporting(true);
                try {
                  const exportRes = await fetch('/api/sheets/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      data: result.data,
                      semester: semester,
                      grade: grade,
                      studentName: extractedName
                    })
                  });
                  if (!exportRes.ok) {
                    const err = await exportRes.json();
                    toast.error(err.error || 'Помилка авто-експорту оцінок');
                  } else {
                    toast.success('Оцінки успішно експортовано');
                  }
                } catch (err) {
                  console.error(err);
                  toast.error('Помилка зв\'язку при авто-експорті оцінок');
                } finally {
                  setIsExporting(false);
                }
            }
          }
        } catch (err) {
          console.error(err);
          toast.error('Помилка перевірки статусу учня');
        }
      } else if (!user) {
        toast.warning('Дані розпізнано, але Google не підключено');
      } else if (!extractedName) {
        toast.error('Прізвище не знайдено в табелі');
      }
    } catch (error) {
      console.error(error);
      toast.error('Не вдалося обробити PDF. Спробуйте ще раз.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConnect = async () => {
    try {
      const res = await fetch('/api/auth/url');
      const { url } = await res.json();
      window.open(url, 'google_auth', 'width=600,height=700');
    } catch (err) {
      toast.error('Не вдалося отримати URL авторизації');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    toast.info('Вихід виконано');
  };

  const handleExport = async () => {
    if (!extractedData || !user) return;

    setIsExporting(true);
    try {
      const res = await fetch('/api/sheets/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: extractedData,
          semester: semester,
          grade: grade,
          studentName: studentName
        })
      });

      if (res.ok) {
        const { spreadsheetUrl } = await res.json();
        setSpreadsheetUrl(spreadsheetUrl);
        toast.success('Експортовано до Google Таблиць!');
      } else {
        const err = await res.json();
        toast.error(err.error || 'Помилка експорту');
      }
    } catch (err) {
      toast.error('Сталася помилка під час експорту');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-4 font-sans">
      <div className="w-full max-w-4xl">
        {/* Subtle Google Auth Status */}
        <div className="absolute top-4 right-4">
          {user ? (
            <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-full border text-xs">
              <img src={user.picture} alt={user.name} className="w-5 h-5 rounded-full" />
              <span className="font-medium truncate max-w-[100px]">{user.name}</span>
              <button onClick={handleLogout} className="text-gray-400 hover:text-gray-600">
                <LogOut className="w-3 h-3" />
              </button>
            </div>
          ) : null}
        </div>
        <Card className="w-full shadow-xl rounded-[40px] overflow-hidden">
          <CardContent className="p-10">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              {/* Left Column: РЕЙТИНГ */}
              <div className="space-y-8">
                <h1 className="text-4xl font-bold text-center text-primary tracking-tight">
                  РЕЙТИНГ
                </h1>

                <div className="space-y-6">
                  {/* Semester Select */}
                  <div className="space-y-2">
                    <Label className="text-lg font-bold text-gray-800">Семестр:</Label>
                    <Select value={semester} onValueChange={setSemester}>
                      <SelectTrigger className="w-full h-12 rounded-xl border-gray-300 text-lg">
                        <SelectValue placeholder="Виберіть семестр" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="I семестр">I семестр</SelectItem>
                        <SelectItem value="II семестр">II семестр</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Grade Select */}
                  <div className="space-y-2">
                    <Label className="text-lg font-bold text-gray-800">Клас:</Label>
                    <Select value={grade} onValueChange={setGrade}>
                      <SelectTrigger className="w-full h-12 rounded-xl border-gray-300 text-lg">
                        <SelectValue placeholder="Виберіть клас" />
                      </SelectTrigger>
                      <SelectContent className="max-h-[300px]">
                        {[5, 6, 7, 8, 9, 10, 11].map((n) => (
                          ['А', 'Б', 'В'].map((l) => (
                            <SelectItem key={`${n}-${l}`} value={`${n}-${l}`}>{`${n}-${l}`}</SelectItem>
                          ))
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Class Mismatch Error */}
                  {classMismatchError && (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-xl text-center font-bold">
                      {classMismatchError}
                    </div>
                  )}

                  {/* Dropzone */}
                  <div
                    {...getRootProps()}
                    className={`
                      border-2 border-dashed rounded-xl p-10 text-center transition-all cursor-pointer
                      ${isDragActive ? 'border-primary bg-primary/5' : 'border-primary/60 hover:border-primary'}
                      ${file ? 'bg-gray-50' : ''}
                    `}
                  >
                    <input {...getInputProps()} />
                    <div className="flex flex-col items-center gap-2">
                      {isAlreadyProcessed ? (
                        <div className="text-lg font-bold text-red-600">Такий учень вже внесений</div>
                      ) : file ? (
                        <div className="flex items-center gap-2 text-primary font-medium">
                          <FileText className="w-5 h-5" />
                          <span className="truncate max-w-[200px]">{file.name}</span>
                        </div>
                      ) : (
                        <p className="text-lg text-gray-700">
                          Натисніть для вибору табеля (.pdf)
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Main Action Button */}
                  <Button
                    className="w-full h-16 rounded-xl bg-primary hover:bg-primary/90 text-white text-xl font-bold uppercase tracking-wider shadow-none"
                    disabled={!file || isProcessing}
                    onClick={handleProcess}
                  >
                    {isProcessing ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : (
                      'ЗАВАНТАЖИТИ'
                    )}
                  </Button>

                  <Button
                    className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-lg font-bold shadow-none"
                    onClick={async () => {
                      try {
                        const res = await fetch(`/api/sheets/list-students?semester=${encodeURIComponent(semester)}&grade=${encodeURIComponent(grade)}`);
                        const data = await res.json();
                        if (data.students && data.students.length > 0) {
                          const newWindow = window.open('', '_blank');
                          if (newWindow) {
                            newWindow.document.write(`
                              <html>
                                <head><title>Внесені учні</title></head>
                                <body>
                                  <h1 style="font-size: 24px;">Внесені учні (${grade}, ${semester})</h1>
                                  <ul style="font-size: 20px; font-weight: bold;">${data.students.map((s: string) => `<li>${s}</li>`).join('')}</ul>
                                </body>
                              </html>
                            `);
                          }
                        } else {
                          alert('Жоден учень не внесений');
                        }
                      } catch (err) {
                        console.error(err);
                        alert('Помилка при отриманні списку учнів');
                      }
                    }}
                  >
                    Внесені учні
                  </Button>

                  {extractedData && (
                    <div className="flex flex-col gap-4 p-4 bg-green-50 border border-green-100 rounded-xl">
                      <div className="space-y-2">
                        <Label className="text-sm font-medium text-green-800">Прізвище та ім'я учня:</Label>
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className={cn("w-5 h-5", studentName ? "text-green-700" : "text-red-500")} />
                          <span className={cn("text-lg font-bold", studentName ? "text-green-900" : "text-red-600")}>
                            {studentName || 'НЕ ЗНАЙДЕНО'}
                          </span>
                        </div>
                        <div className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded-full inline-block">
                          {extractedData.length} предметів розпізнано
                        </div>
                      </div>

                      {!studentName && summary && (
                        <div className="text-xs text-gray-500 bg-gray-100 p-2 rounded border border-gray-200 italic">
                          Примітка AI: {summary}
                        </div>
                      )}
                      
                      {!user && (
                        <Button
                          variant="outline"
                          className="w-full border-green-200 text-green-700"
                          onClick={handleConnect}
                        >
                          Підключити Google для авто-експорту
                        </Button>
                      )}
                      
                      {isExporting && (
                        <div className="flex items-center justify-center gap-2 text-sm text-green-600 animate-pulse">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Занесення в таблицю...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: ГРОМАДСЬКА РОБОТА */}
              <AnimatePresence>
                {extractedData && !isAlreadyProcessed && (
                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="space-y-6"
                  >
                    <div className="p-6 bg-white border border-gray-200 rounded-[30px] shadow-sm space-y-6">
                      <h2 className="text-2xl font-bold text-primary text-center tracking-tight">ГРОМАДСЬКА РОБОТА</h2>
                      
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-gray-700">Суспільно корисна діяльність, акції:</Label>
                          <input 
                            type="number" 
                            name="activity"
                            min="1" 
                            max="3" 
                            className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-primary focus:outline-none" 
                            placeholder="Межі балів 1-3" 
                            value={socialWork.activity}
                            onChange={(e) => handleSocialWorkChange('activity', e.target.value, 1, 3)}
                            onKeyDown={(e) => handleKeyDown(e, 'tasks')}
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-gray-700">Постійні доручення у класі:</Label>
                          <input 
                            type="number" 
                            name="tasks"
                            min="1" 
                            max="4" 
                            className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-primary focus:outline-none" 
                            placeholder="Межі балів 1-4" 
                            value={socialWork.tasks}
                            onChange={(e) => handleSocialWorkChange('tasks', e.target.value, 1, 4)}
                            onKeyDown={(e) => handleKeyDown(e, 'behavior', 'activity')}
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-gray-700">Поведінка:</Label>
                          <input 
                            type="number" 
                            name="behavior"
                            min="1" 
                            max="5" 
                            className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-primary focus:outline-none" 
                            placeholder="Межі балів 1-5" 
                            value={socialWork.behavior}
                            onChange={(e) => handleSocialWorkChange('behavior', e.target.value, 1, 5)}
                            onKeyDown={(e) => handleKeyDown(e, 'remarks', 'tasks')}
                          />
                        </div>
                        
                        <div className="space-y-2">
                          <Label className="text-sm font-medium text-gray-700">Стягнення та зауваження у класі:</Label>
                          <input 
                            type="number" 
                            name="remarks"
                            min="1" 
                            max="10" 
                            className="w-full border border-gray-300 rounded-xl px-4 py-3 focus:ring-2 focus:ring-primary focus:outline-none" 
                            placeholder="Межі балів 1-10" 
                            value={socialWork.remarks}
                            onChange={(e) => handleSocialWorkChange('remarks', e.target.value, 1, 10)}
                            onKeyDown={(e) => handleKeyDown(e, undefined, 'behavior')}
                          />
                        </div>
                        
                        <Button 
                          className="w-full h-12 rounded-xl bg-green-800 hover:bg-green-900 text-white font-bold uppercase tracking-wider"
                          onClick={handleSaveSocialWork}
                          disabled={isExporting}
                        >
                          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'ЗБЕРЕГТИ'}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </CardContent>
        </Card>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
