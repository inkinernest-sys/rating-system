import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export async function extractDataFromPDF(base64Data: string, mimeType: string) {
  const model = "gemini-3-flash-preview";

  const prompt = `
    This is a PDF of a school report card (Табель).
    
    1. Extract the student's FULL NAME (Surname and First Name) and CLASS NAME.
       - Look for labels like "прізвище, ім’я учня", "учня (учениці)", "Прізвище, ім'я", or "виданий".
       - Look for the class name between words like "учня" and "класу" (e.g., "учня 8-В класу").
       - EXPECTED FORMAT: "Surname Name" (e.g., "Бендюк Каріна") and "Class" (e.g., "8-В").
       - CRITICAL: Return "className" as a specific field.
       
    2. Extract the table of grades from the page that contains subjects.
       - Find the table with subjects and grade columns, and map grades to sem1, sem2, and yearly based on the table's structure.
       - For each row in the table:
         a. Extract the EXACT subject name from the "Предмети" column. Do NOT abbreviate.
         b. Extract the grade from the "I семестр" sub-column into "sem1".
         c. Extract the grade from the "II семестр" sub-column into "sem2".
         d. Extract the grade from the "Річні" column into "yearly".
       - CRITICAL: If a cell is empty, you MUST return an empty string "". Never guess or copy from another column.
       - CRITICAL: "Фізична культура", "Фізична культура(плавання)" and "Фізична культура(хорегографія)" are DIFFERENT subjects. They often appear in separate rows. Extract their grades exactly as they appear in their respective rows.
       - IMPORTANT: Ensure you extract subjects like "Музичне мистецтво" and "Християнська етика" even if their "I семестр" column is empty.
    
    Return the data in a structured format.
    The "data" array should contain objects where each object is a subject with its grades.
    Include the "studentName" as a top-level field.
    In the "summary" field, explain where you found the name or why you couldn't find it.
  `;

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            studentName: {
              type: Type.STRING,
              description: "Full name of the student extracted from the first page.",
            },
            className: {
              type: Type.STRING,
              description: "Class name of the student (e.g., 8-В) extracted from the first page.",
            },
            data: {
              type: Type.ARRAY,
              description: "List of subjects and their grades.",
              items: {
                type: Type.OBJECT,
                properties: {
                  subject: { type: Type.STRING, description: "Name of the subject." },
                  sem1: { type: Type.STRING, description: "Grade for the 1st semester." },
                  sem2: { type: Type.STRING, description: "Grade for the 2nd semester." },
                  yearly: { type: Type.STRING, description: "Yearly grade." },
                },
                required: ["subject"],
              },
            },
            summary: {
              type: Type.STRING,
              description: "A brief summary of the extraction.",
            },
          },
          required: ["data", "studentName", "className", "summary"],
        },
      },
    });

    console.log("Gemini API call successful");
    const text = (response.text || "{}").replace(/```json\n?|\n?```/g, "");
    const result = JSON.parse(text);
    return result;
  } catch (error) {
    console.error("Gemini API call failed:", error);
    throw new Error(`Failed to extract data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
