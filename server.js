const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const API_URL = "https://strategy-cube-vinyl-warcraft.trycloudflare.com/api/txmd5";

// ==================== BỘ NHỚ & THUẬT TOÁN ====================
let gameHistory = [];
let predictionLog = [];
let lastPrediction = null;
let lastProcessedPhien = null;
let lastSessionId = null;

// Cấu trúc bộ nhớ thuật toán
let cauMemory = { biet: { Tai: {}, Xiu: {} } };
let diceMemory = {
    x1: {1:0,2:0,3:0,4:0,5:0,6:0}, x2: {1:0,2:0,3:0,4:0,5:0,6:0}, x3: {1:0,2:0,3:0,4:0,5:0,6:0},
    tong: {3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0,12:0,13:0,14:0,15:0,16:0,17:0,18:0},
    transition: { x1: [], x2: [], x3: [] },
    highLow: {}, oddEven: {}
};
let scoreMemory = { afterScore: {}, movingAvg: { MA5: [] } };
let patternMemory = { patternNext: {} };

for(let i=0;i<=6;i++) {
    diceMemory.transition.x1[i] = {1:0,2:0,3:0,4:0,5:0,6:0};
    diceMemory.transition.x2[i] = {1:0,2:0,3:0,4:0,5:0,6:0};
    diceMemory.transition.x3[i] = {1:0,2:0,3:0,4:0,5:0,6:0};
}

// Cập nhật bộ nhớ
function updateDiceMemory(d1,d2,d3,total) {
    diceMemory.x1[d1]++; diceMemory.x2[d2]++; diceMemory.x3[d3]++;
    diceMemory.tong[total]++;
    let hl = (d1>=4?'H':'L')+(d2>=4?'H':'L')+(d3>=4?'H':'L');
    diceMemory.highLow[hl] = (diceMemory.highLow[hl]||0)+1;
    let oe = (d1%2===0?'C':'L')+(d2%2===0?'C':'L')+(d3%2===0?'C':'L');
    diceMemory.oddEven[oe] = (diceMemory.oddEven[oe]||0)+1;
    if(gameHistory.length >= 2) {
        let prev = gameHistory[gameHistory.length-2];
        diceMemory.transition.x1[prev.dice[0]][d1]++;
        diceMemory.transition.x2[prev.dice[1]][d2]++;
        diceMemory.transition.x3[prev.dice[2]][d3]++;
    }
}

function updateScoreMemory(total) {
    if(gameHistory.length >= 2) {
        let prevScore = gameHistory[gameHistory.length-2].tong;
        if(!scoreMemory.afterScore[prevScore]) scoreMemory.afterScore[prevScore] = {};
        scoreMemory.afterScore[prevScore][total] = (scoreMemory.afterScore[prevScore][total]||0)+1;
    }
    let n = gameHistory.length;
    if(n >= 5) {
        let ma5 = gameHistory.slice(-5).map(h=>h.tong).reduce((a,b)=>a+b,0)/5;
        scoreMemory.movingAvg.MA5.push(ma5);
        if(scoreMemory.movingAvg.MA5.length>100) scoreMemory.movingAvg.MA5.shift();
    }
}

function updatePatternMemory(result) {
    if(gameHistory.length < 4) return;
    let r = result==='Tài'?'T':'X';
    let results = gameHistory.map(h=>h.ket_qua==='Tài'?'T':'X');
    let pattern = results.slice(-4,-1).join('');
    let nextKey = pattern+'->'+r;
    patternMemory.patternNext[nextKey] = (patternMemory.patternNext[nextKey]||0)+1;
}

function updateCauMemory(result) {
    let n = gameHistory.length;
    if(n<3) return;
    let results = gameHistory.map(h=>h.ket_qua);
    let streak=1;
    for(let i=n-2;i>=0;i--) if(results[i]===result) streak++; else break;
    if(streak>=3) {
        if(result==='Tài') cauMemory.biet.Tai[streak] = (cauMemory.biet.Tai[streak]||0)+1;
        else cauMemory.biet.Xiu[streak] = (cauMemory.biet.Xiu[streak]||0)+1;
    }
}

function addSession(phien, ketQua, tong, x1,x2,x3) {
    if(gameHistory.some(h=>h.phien===phien)) return false;
    gameHistory.push({ phien, ket_qua: ketQua, tong, dice:[x1,x2,x3], timestamp:Date.now() });
    if(gameHistory.length>500) gameHistory.shift();
    updateDiceMemory(x1,x2,x3,tong);
    updateScoreMemory(tong);
    updatePatternMemory(ketQua);
    updateCauMemory(ketQua);
    return true;
}

// DỰ ĐOÁN CHÍNH (KHÔNG RANDOM)
function predictSuper() {
    let n = gameHistory.length;
    if(n < 5) return { prediction: "Xỉu", confidence: 55 };
    
    let predictions = [];
    let results = gameHistory.map(h=>h.ket_qua==='Tài'?'T':'X');
    let lastResult = gameHistory[n-1].ket_qua;
    let lastD1 = gameHistory[n-1].dice[0]||0, lastD2 = gameHistory[n-1].dice[1]||0, lastD3 = gameHistory[n-1].dice[2]||0;
    let lastScore = gameHistory[n-1].tong;
    
    // 1. Pattern
    for(let len of [3,4,5]) {
        if(n >= len) {
            let pattern = results.slice(-len).join('');
            let nextT = patternMemory.patternNext[pattern+'->T'] || 0;
            let nextX = patternMemory.patternNext[pattern+'->X'] || 0;
            let total = nextT+nextX;
            if(total >= 3) {
                let probT = nextT/total;
                predictions.push({ pred: probT>0.5?'Tài':'Xỉu', conf: Math.abs(probT-0.5)*2*100, weight: 0.12 });
            }
        }
    }
    
    // 2. Streak
    let streak = 1;
    for(let i=n-2;i>=0;i--) if(gameHistory[i].ket_qua===lastResult) streak++; else break;
    if(streak >= 3) {
        let countLonger = 0;
        for(let s=streak+1; s<=12; s++) {
            countLonger += lastResult==='Tài'?(cauMemory.biet.Tai[s]||0):(cauMemory.biet.Xiu[s]||0);
        }
        let countThis = lastResult==='Tài'?(cauMemory.biet.Tai[streak]||0):(cauMemory.biet.Xiu[streak]||0);
        let total = countThis + countLonger;
        if(total > 0) {
            let probContinue = countLonger/total;
            predictions.push({ pred: probContinue>0.5?lastResult:(lastResult==='Tài'?'Xỉu':'Tài'), conf: Math.abs(probContinue-0.5)*2*100+30, weight: 0.18 });
        }
    }
    
    // 3. AfterScore
    if(scoreMemory.afterScore[lastScore]) {
        let after = scoreMemory.afterScore[lastScore];
        let totalAfter = 0, taiAfter = 0;
        for(let s=3;s<=18;s++) {
            totalAfter += after[s]||0;
            if(s>=11) taiAfter += after[s]||0;
        }
        if(totalAfter >= 3) {
            let probT = taiAfter/totalAfter;
            predictions.push({ pred: probT>0.5?'Tài':'Xỉu', conf: Math.abs(probT-0.5)*2*100+30, weight: 0.13 });
        }
    }
    
    // 4. Dice transition
    let trans1 = diceMemory.transition.x1[lastD1] || {};
    let trans2 = diceMemory.transition.x2[lastD2] || {};
    let trans3 = diceMemory.transition.x3[lastD3] || {};
    let maxD1=1, maxD2=1, maxD3=1, maxC1=0, maxC2=0, maxC3=0;
    for(let f=1;f<=6;f++) {
        if((trans1[f]||0)>maxC1) { maxC1=trans1[f]||0; maxD1=f; }
        if((trans2[f]||0)>maxC2) { maxC2=trans2[f]||0; maxD2=f; }
        if((trans3[f]||0)>maxC3) { maxC3=trans3[f]||0; maxD3=f; }
    }
    let predTotal = maxD1+maxD2+maxD3;
    predictions.push({ pred: predTotal>=11?'Tài':'Xỉu', conf: 55, weight: 0.08 });
    
    // 5. High-Low
    let currentHL = (lastD1>=4?'H':'L')+(lastD2>=4?'H':'L')+(lastD3>=4?'H':'L');
    let hlKeys = Object.keys(diceMemory.highLow);
    let hlIdx = hlKeys.indexOf(currentHL);
    let nextHL = hlKeys[(hlIdx+1)%hlKeys.length];
    let hlFreq = diceMemory.highLow[nextHL] || 0;
    let hlTotal = Object.values(diceMemory.highLow).reduce((a,b)=>a+b,0);
    if(hlTotal>0 && hlFreq/hlTotal > 0.15) {
        let hCount = (nextHL.match(/H/g)||[]).length;
        predictions.push({ pred: hCount>=2?'Tài':'Xỉu', conf: 55+hlFreq/hlTotal*40, weight: 0.05 });
    }
    
    // 6. Odd-Even
    let currentOE = (lastD1%2===0?'C':'L')+(lastD2%2===0?'C':'L')+(lastD3%2===0?'C':'L');
    let oeKeys = Object.keys(diceMemory.oddEven);
    let oeIdx = oeKeys.indexOf(currentOE);
    let nextOE = oeKeys[(oeIdx+1)%oeKeys.length];
    let oeFreq = diceMemory.oddEven[nextOE] || 0;
    let oeTotal = Object.values(diceMemory.oddEven).reduce((a,b)=>a+b,0);
    if(oeTotal>0 && oeFreq/oeTotal > 0.15) {
        let cCount = (nextOE.match(/C/g)||[]).length;
        predictions.push({ pred: cCount>=2?'Xỉu':'Tài', conf: 55+oeFreq/oeTotal*40, weight: 0.05 });
    }
    
    // 7. Bẻ cầu
    if(streak >= 6) {
        predictions.push({ pred: lastResult==='Tài'?'Xỉu':'Tài', conf: 70+Math.min(20,(streak-6)*4), weight: 0.12 });
    }
    
    // 8. MA5
    if(scoreMemory.movingAvg.MA5.length >= 2) {
        let lastMA5 = scoreMemory.movingAvg.MA5[scoreMemory.movingAvg.MA5.length-1];
        if(lastMA5 > 13) predictions.push({ pred:'Xỉu', conf:60, weight:0.05 });
        if(lastMA5 < 7) predictions.push({ pred:'Tài', conf:60, weight:0.05 });
    }
    
    // 9. Adaptive
    if(predictionLog.length >= 8) {
        let last8 = predictionLog.slice(-8);
        let wrong = last8.filter(p=>!p.correct).length;
        if(wrong >= 6) return { prediction: "Xỉu", confidence: 55 };
        if(wrong >= 4) {
            let lastPred = predictionLog[predictionLog.length-1].pred;
            predictions.push({ pred: lastPred==='Tài'?'Xỉu':'Tài', conf: 60, weight: 0.18 });
        }
    }
    
    if(predictions.length === 0) {
        let taiTotal = gameHistory.filter(h=>h.ket_qua==='Tài').length;
        let xiuTotal = gameHistory.length - taiTotal;
        let fallback = taiTotal > xiuTotal ? 'Xỉu' : 'Tài';
        return { prediction: fallback, confidence: 55 };
    }
    
    let scoreTai = 0, scoreXiu = 0, totalWeight = 0;
    for(let p of predictions) {
        let w = p.weight * (p.conf/100);
        totalWeight += w;
        if(p.pred === 'Tài') scoreTai += w;
        else scoreXiu += w;
    }
    let prob = scoreTai / totalWeight;
    let finalPred = prob > 0.5 ? 'Tài' : 'Xỉu';
    let confidence = Math.min(95, Math.max(55, Math.round(Math.abs(prob-0.5)*2*100)));
    return { prediction: finalPred, confidence };
}

// ==================== ĐỒNG BỘ DỮ LIỆU TỪ API GỐC ====================
async function fetchAndUpdate() {
    try {
        const res = await axios.get(API_URL, { timeout: 10000 });
        const d = res.data;
        const phien = String(d.phien);
        const ketQuaRaw = d.ket_qua;
        if(!phien || !ketQuaRaw) return;
        if(lastProcessedPhien === phien) return;
        lastProcessedPhien = phien;
        
        let ketQua = (ketQuaRaw === "Xỉu" ? "Xỉu" : (ketQuaRaw === "Tài" ? "Tài" : ketQuaRaw));
        const tong = d.tong || 0;
        const dice = [d.xuc_xac_1||0, d.xuc_xac_2||0, d.xuc_xac_3||0];
        
        if(!gameHistory.some(h=>h.phien===phien)) {
            addSession(phien, ketQua, tong, dice[0], dice[1], dice[2]);
        }
        
        if(lastPrediction !== null && lastSessionId !== null && lastSessionId !== phien) {
            const isCorrect = (lastPrediction === ketQua);
            predictionLog.push({ pred: lastPrediction, correct: isCorrect });
            if(predictionLog.length > 100) predictionLog.shift();
        }
        lastSessionId = phien;
        
    } catch(err) {
        console.error("Lỗi fetch API gốc:", err.message);
    }
}

setInterval(fetchAndUpdate, 20000);
fetchAndUpdate();

// ==================== ENDPOINT CHÍNH (GIỐNG HỆT API GỐC) ====================
app.get("/api/txmd5", (req, res) => {
    const latest = gameHistory[gameHistory.length - 1];
    if (!latest) {
        return res.json({
            betting_info: {
                nguoi_cuoc: { tai: 0, xiu: 0 },
                phien_cuoc: null,
                tien_cuoc: { tai: "0", xiu: "0" },
                tong_nguoi_cuoc: 0,
                tong_tien_cuoc: "0",
                trang_thai: "Đang cược"
            },
            ket_qua: "Chưa có",
            phien: null,
            tong: 0,
            xuc_xac_1: 0,
            xuc_xac_2: 0,
            xuc_xac_3: 0,
            update_at: new Date().toISOString(),
            tick_update_at: new Date().toISOString()
        });
    }
    
    const pred = predictSuper();
    const nextPhien = parseInt(latest.phien) + 1;
    
    // Lấy thông tin betting (có thể từ API gốc hoặc tự tính)
    // Ở đây tôi giữ cấu trúc y hệt, dữ liệu có thể để mẫu hoặc lấy từ gameHistory
    const betting_info = {
        nguoi_cuoc: { tai: 0, xiu: 0 },
        phien_cuoc: nextPhien,
        tien_cuoc: { tai: "0", xiu: "0" },
        tong_nguoi_cuoc: 0,
        tong_tien_cuoc: "0",
        trang_thai: "Đang cược"
    };
    
    // Tạo md5_raw giả lập (bạn có thể tính thật nếu cần)
    const md5_raw = `${latest.phien}:${latest.dice.join("-")}${Date.now().toString().slice(-8)}`;
    
    res.json({
        betting_info: betting_info,
        ket_qua: pred.prediction === "Tài" ? "Tài" : "Xỉu",
        md5_raw: md5_raw,
        phien: latest.phien,
        tong: latest.tong,
        xuc_xac_1: latest.dice[0],
        xuc_xac_2: latest.dice[1],
        xuc_xac_3: latest.dice[2],
        update_at: new Date().toISOString(),
        tick_update_at: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API chạy tại: http://localhost:${PORT}/api/txmd5`);
    console.log(`📡 Trả về đúng cấu trúc giống API gốc`);
});