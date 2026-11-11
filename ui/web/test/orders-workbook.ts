import ExcelJS from "exceljs";

/**
 * The agent's computed orders table as a spreadsheet library writes it (openpyxl's layout): formulas with no stored
 * results, a `0.0%` format on the return rates, a bold header and the header row frozen.
 */
export async function ordersXlsx(): Promise<ArrayBuffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Orders", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(["Region", "Orders", "Returns", "Kept", "Return rate"]).font = { bold: true };
  [["North", 120, 12], ["South", 95, 7], ["East", 80, 4], ["West", 65, 9]].forEach((values, at) => {
    const row = at + 2;
    sheet.addRow([...values, { formula: `B${row}-C${row}` }, { formula: `C${row}/B${row}` }]);
    sheet.getCell(`E${row}`).numFmt = "0.0%";
  });
  return new Uint8Array(await book.xlsx.writeBuffer()).slice().buffer;
}
