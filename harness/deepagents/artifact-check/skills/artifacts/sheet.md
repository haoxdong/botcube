# Sheet

A Sheet is one `<name>.sheet.json` file: `{"edits": [...]}`, a list of edits applied in order, each naming its `sheet` (a sheet is made by the first edit that names it). Publish it with `file_path` = that file. It shows once published, and the User downloads it as Excel with its formulas.

Link each row's source in a source column with `=HYPERLINK("https://…","key words")`.

The edit kinds: `writeCells` (`topLeft`, `rows` of values), `formatCells` (`ranges`, `format`), `setBorders` (`range`, `edges`, `border`), `setColumnWidths` (`columns`, `widthInPixels`), `fitColumns` (`columns`), `setSheetSettings` (`settings`: `lastFrozenRow`, `lastFrozenColumn`, `areGridlinesHidden`), `mergeCells` (`ranges`) and `importFile` (`asset`). Any other kind is refused by name. A range is `A1:C4` or one cell; columns are `B:C` or `B`. A sheet's name is 1 to 31 characters with none of `[ ] : * ? / \`, as Excel requires.

`writeCells` reads each string as if typed into the cell: `"=SUM(B2:B9)"` is a formula, `"50%"` the number 0.5 shown as a percent, `"$1,200"` money, `"2026-03-15"` a date, and a leading `'` keeps text (`"'02139"`). Numbers, `true`, `false` and `null` (an empty cell) are written as they are. Excel can't read an open-ended range such as `F2:F`: name the last row (`F2:F200`).

For a large or computed table, save it with code as an `.xlsx` or `.csv` File and import it: `{"kind":"importFile","asset":"/data/orders.xlsx"}`, then format it with later edits. An import always makes new sheets: an `.xlsx`'s sheets keep their names, a `.csv` becomes one sheet named after the file (`orders`), and a name already taken gets ` (2)`. An `.xlsx` keeps its formulas, number formats, looks and frozen panes; a `.csv` keeps values only, so a formula in it arrives as text. Publishing keeps a copy of the File with that version, so later changes to the File show only once you publish again; a missing File is refused.

<!-- prettier-ignore-start -->

A budget and a task list, `sheets/q4.sheet.json`:

```json
{"edits": [
{"kind":"writeCells","sheet":"Budget","topLeft":"A1","rows":[["Item","Cost","Source"],["Rent",1200,"=HYPERLINK(\"https://example.com/rent\",\"Lease\")"],["Zip","'02139","=HYPERLINK(\"https://example.com/address\",\"Address\")"],["Total","=SUM(B2:B3)","=HYPERLINK(\"https://example.com/budget\",\"Budget\")"]]},
{"kind":"formatCells","sheet":"Budget","ranges":["A1:B1","A4:B4"],"format":{"font":{"bold":true,"italic":false,"underline":"none","strikethrough":false,"size":12,"color":{"kind":"rgb","hex":"#ffffff"}},"fillColor":{"kind":"standard","hue":"blue","shade":600},"alignment":{"horizontal":"center","vertical":"center","wrap":true},"numberFormat":{"pattern":"$#,##0.00"},"border":{"bottom":{"kind":"line","style":"medium","color":{"kind":"none"}}}}},
{"kind":"setBorders","sheet":"Budget","range":"A1:B4","edges":"outer","border":{"kind":"line","style":"thin","color":{"kind":"none"}}},
{"kind":"setColumnWidths","sheet":"Budget","columns":"A:B","widthInPixels":160},
{"kind":"mergeCells","sheet":"Budget","ranges":["A6:B6","A9:B9"]},
{"kind":"setSheetSettings","sheet":"Budget","settings":{"areGridlinesHidden":true}},
{"kind":"writeCells","sheet":"Tasks","topLeft":"A1","rows":[["Task","Owner","Due","Status","Done","Hours","Notes","Source"]]},
{"kind":"formatCells","sheet":"Tasks","ranges":["A1:H1"],"format":{"font":{"bold":true},"fillColor":{"kind":"rgb","hex":"#f3f3f3"}}},
{"kind":"writeCells","sheet":"Tasks","topLeft":"A2","rows":[["Draft the brief","Ana","2026-03-02","Done",true,3,"Sent to legal on Friday. They asked for the vendor list and the renewal dates.","=HYPERLINK(\"https://example.com/brief\",\"Brief\")"],["Book the venue","Raj","2026-03-09","In progress",false,1.5,null,"=HYPERLINK(\"https://example.com/venue\",\"Venue\")"],["Send invitations","Ana","2026-03-16","To do",false,2,null,"=HYPERLINK(\"https://example.com/invitations\",\"Invitations\")"]]},
{"kind":"writeCells","sheet":"Tasks","topLeft":"I1","rows":[["Hours left","=SUMIFS(F2:F200,E2:E200,FALSE)"]]},
{"kind":"formatCells","sheet":"Tasks","ranges":["F2:F200"],"format":{"numberFormat":{"pattern":"0.0"}}},
{"kind":"formatCells","sheet":"Tasks","ranges":["G2:G200"],"format":{"alignment":{"wrap":true}}},
{"kind":"formatCells","sheet":"Tasks","ranges":["I1"],"format":{"font":{"bold":true}}},
{"kind":"setColumnWidths","sheet":"Tasks","columns":"G","widthInPixels":320},
{"kind":"fitColumns","sheet":"Tasks","columns":"A:F"},
{"kind":"fitColumns","sheet":"Tasks","columns":"I:J"},
{"kind":"setBorders","sheet":"Tasks","range":"A9:G9","edges":"top","border":{"kind":"line","style":"thin","color":{"kind":"none"}}},
{"kind":"setSheetSettings","sheet":"Tasks","settings":{"lastFrozenRow":1}}
]}
```

<!-- prettier-ignore-end -->
