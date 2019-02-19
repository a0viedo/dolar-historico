'use strict';

const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const util = require('util');
const spreadsheet = {};
if(process.env.NODE_ENV === 'dev') {
  require('dotenv').config();
}

module.exports.handler = async () => {
  const auth = authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  spreadsheet.update = util.promisify(sheets.spreadsheets.values.update);
  spreadsheet.create = util.promisify(sheets.spreadsheets.create);
  spreadsheet.batchUpdate = util.promisify(sheets.spreadsheets.batchUpdate);
  spreadsheet.get = util.promisify(sheets.spreadsheets.get);

  try {
    const sheetList = await getSheetList();
    if(sheetList.length >= 200) {
      await deleteLastSheet();
    }
    const sheetName = new Date().toISOString().substring(0, 10);
    const [result, data] = await Promise.all([
      await addSheet(sheetName),
      await getData()
    ]);

    const sortedData = [data.shift(), ...sortData(data)];
    const sheetId = getSheetId(result);
    await writeToSheet(`${sheetName}!${getDataRange(sortedData)}`, sortedData);
    await formatSheet(sheetId, sortedData);

    console.log(`finished writing data and formatting sheetId ${sheetId} (name "${sheetName}")`);
    return {};
  } catch(err) {
    console.log('There was an error', err);
  }
};

function authorize() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({
    access_token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    expiry_date: process.env.GOOGLE_EXPIRY_DATE,
    token_type: process.env.GOOGLE_TOKEN_TYPE
  });
  return oAuth2Client;
}

async function writeToSheet(range, data) {
  return spreadsheet.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range,
    resource: {
      values: data
    },
    valueInputOption: 'RAW'
  });
}

async function addSheet(name) {
  return spreadsheet.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        {
          addSheet: {
            properties: {
              title: name,
              index: 0
            }
          }
        }
      ]
    }
  });
}

async function formatSheet(sheetId, data) {
  return spreadsheet.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        // add borders
        {
          updateBorders: {
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: data.length,
              startColumnIndex: 0,
              endColumnIndex: 3
            },
            top: {
              style: 'SOLID',
              width: 1
            },
            bottom: {
              style: 'SOLID',
              width: 1
            },
            left: {
              style: 'SOLID',
              width: 1
            },
            right: {
              style: 'SOLID',
              width: 1
            },
            innerHorizontal: {
              style: 'SOLID',
              width: 1
            },
            innerVertical: {
              style: 'SOLID',
              width: 1
            },
          }
        },
        // make first row bold
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startRowIndex: 0,
              endRowIndex: 1
            },
            cell: {
              userEnteredFormat: {
                textFormat: {
                  bold: true
                }
              }
            },
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)'
          }
        },
        // make second and third columns centered horizontally
        {
          repeatCell: {
            range: {
              sheetId: sheetId,
              startColumnIndex: 1,
              endColumnIndex: 3
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: 'CENTER',
              }
            },
            fields: 'userEnteredFormat(horizontalAlignment)'
          }
        },
        // cut unused columns and rows
        {
          updateSheetProperties: {
            properties: {
              sheetId,
              gridProperties: {
                rowCount: data.length,
                columnCount: data[0].length
              }
            },
            fields: 'gridProperties(rowCount, columnCount)'
          }
        },
        // autoresize columns
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: sheetId,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 3
            }
          }
        }

      ],
    }
  });
}

async function deleteLastSheet(sheetList) {
  const sheetId = sheetList[sheetList.length -1];
  return spreadsheet.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    resource: {
      requests: [
        {
          deleteSheet: {
            sheetId
          }
        }
      ]
    }
  });
}

async function getSheetList() {
  const result = await spreadsheet.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID
  });
  return result.data.sheets.map(sheet => sheet.properties.sheetId);
}

function getSheetId(data) {
  return data.data.replies[0].addSheet.properties.sheetId;
}

function getDataRange(data){
  const start = 'A1';
  const end = String.fromCharCode(64+ data[0].length) + data.length;
  return `${start}:${end}`;
}

async function getData() {
  console.log(`starting to get data from ${process.env.CRAWL_URL}`);
  const before = new Date();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/opt/headless_shell',
    args: ['--no-sandbox', '--disable-gpu', '--single-process', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.resourceType() === 'image') {
      request.abort();
    } else {
      request.continue();
    }
  });

  await page.goto(process.env.CRAWL_URL, {});

  const data = await page.evaluate(() => {
    const result = [];
    const table = document.querySelector('#ctl00_PlaceHolderMainContent_GridViewDolar');
    for(let i = 0; i < table.rows.length; i++) {
      let tr = table.rows[i];
      result.push([
        tr.children[0].innerText.trim(),
        tr.children[1].innerText.split('\n')[0],
        tr.children[2].innerText.split('\n')[0]
      ]);
    }
    return result;
  });
  console.log(`finished to get crawler data in ${new Date().getTime() - before.getTime()} milliseconds`);

  return data;
}

function sortData(data) {
  return data.sort((a, b) => a[0].localeCompare(b[0]));
}