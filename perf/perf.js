'use strict';

var expect = require('chai').expect;
var spawn = require('child_process').spawn;
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var fs = require('fs');
var async = require('async');
var RPC = require('botcoind-rpc');
var http = require('http');
var botcore = require('botcore-lib');
var PrivateKey = botcore.PrivateKey;
var Transaction = botcore.Transaction;

console.log('This test takes a really long time to run, be patient.');

var rpcConfig = {
  protocol: 'http',
  user: 'local',
  pass: 'localtest',
  host: '127.0.0.1',
  port: 58332,
  rejectUnauthorized: false
};

var blocksGenerated = 0;
var startingAddr;
var startingTx;
var amtToSendToEach;
var utxoCount = 3000;
var outputKeys = [];
var rpc1 = new RPC(rpcConfig);
var debug = true;
var botcoreDataDir = '/tmp/botcore';
var botcoinDataDirs = ['/tmp/botcoin'];

var botcoin = {
  args: {
    datadir: null,
    listen: 1,
    regtest: 1,
    server: 1,
    rpcuser: 'local',
    rpcpassword: 'localtest',
    //printtoconsole: 1
    rpcport: 58332,
  },
  datadir: null,
  exec: 'botcoind', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/botcoind
  processes: []
};

var botcore = {
  configFile: {
    file: botcoreDataDir + '/botcore-node.json',
    conf: {
      network: 'regtest',
      port: 53001,
      datadir: botcoreDataDir,
      services: [
        'p2p',
        'db',
        'header',
        'block',
        'address',
        'transaction',
        'mempool',
        'web',
        'insight-api',
        'fee',
        'timestamp'
      ],
      servicesConfig: {
        'p2p': {
          'peers': [
            { 'ip': { 'v4': '127.0.0.1' }, port: 18444 }
          ]
        },
        'insight-api': {
          'routePrefix': 'api'
        }
      }
    }
  },
  httpOpts: {
    protocol: 'http:',
    hostname: 'localhost',
    port: 53001,
  },
  opts: { cwd: botcoreDataDir },
  datadir: botcoreDataDir,
  exec: 'botcored',  //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/botcored
  args: ['start'],
  process: null
};

var startBitcoind = function(count, callback) {

  var listenCount = 0;
  async.timesSeries(count, function(n, next) {

    var datadir = botcoinDataDirs.shift();

    botcoin.datadir = datadir;
    botcoin.args.datadir = datadir;

    if (listenCount++ > 0) {
      botcoin.args.listen = 0;
      botcoin.args.rpcport++;
      botcoin.args.connect = '127.0.0.1';
    }

    rimraf(datadir, function(err) {

      if(err) {
        return next(err);
      }

      mkdirp(datadir, function(err) {

        if(err) {
          return next(err);
        }

        var args = botcoin.args;
        var argList = Object.keys(args).map(function(key) {
          return '-' + key + '=' + args[key];
        });

        var botcoinProcess = spawn(botcoin.exec, argList, botcoin.opts);
        botcoin.processes.push(botcoinProcess);

        botcoinProcess.stdout.on('data', function(data) {

          if (debug) {
            process.stdout.write(data.toString());
          }

        });

        botcoinProcess.stderr.on('data', function(data) {

          if (debug) {
            process.stderr.write(data.toString());
          }

        });

        next();

      });

    });
  }, function(err) {

      if (err) {
        return callback(err);
      }

      var pids = botcoin.processes.map(function(process) {
        return process.pid;
      });

      console.log(count + ' botcoind\'s started at pid(s): ' + pids);
      async.retry({ interval: 1000, times: 1000 }, function(next) {
        rpc1.getInfo(next);
      }, callback);
  });
};


var request = function(httpOpts, callback) {

  var request = http.request(httpOpts, function(res) {

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      return callback('Error from botcore-node webserver: ' + res.statusCode);
    }

    var resError;
    var resData = '';

    res.on('error', function(e) {
      resError = e;
    });

    res.on('data', function(data) {
      resData += data;
    });

    res.on('end', function() {

      if (resError) {
        return callback(resError);
      }
      var data = JSON.parse(resData);
      callback(null, data);

    });

  });

  request.on('error', function(err) {
    callback(err);
  });
  request.write('');
  request.end();
};

var shutdownBitcoind = function(callback) {
  botcoin.processes.forEach(function(process) {
    process.kill();
  });
  setTimeout(callback, 3000);
};

var shutdownBitcore = function(callback) {
  if (botcore.process) {
    botcore.process.kill();
  }
  callback();
};


var buildInitialTx = function(utxo, key) {

  amtToSendToEach = Math.floor(utxo.satoshis / outputKeys.length) - 100;

  var tx = new Transaction().from(utxo);

  outputKeys.forEach(function(key) {
    tx.to(key.toAddress(), amtToSendToEach);
  });

  tx.sign(key);

  return tx;

};

var buildOutputKeys = function() {
  for(var i = 0; i < utxoCount; i++) {
    outputKeys.push(new PrivateKey('testnet'));
  }
};

var buildReturnTxs = function() {

  console.log('Building return txs...');
  var txs = [];

  for(var i = 0; i < outputKeys.length; i++) {
    var key = outputKeys[i];
    var address = key.toAddress();
    var utxo = {
      txId: startingTx.hash,
      outputIndex: i,
      address: address,
      script: startingTx.outputs[i].script.toHex(),
      satoshis: startingTx.outputs[i].satoshis
    };
    var tx = new Transaction().from(utxo).to(startingAddr, amtToSendToEach - 1000).sign(key);
    txs.push(tx);
  }
  return txs;
};

var buildInitialChain = function(callback) {

  async.waterfall([

    function(next) {
      buildOutputKeys();
      next();
    },
    function(next) {
      blocksGenerated += 101;
     rpc1.generate(101, next);
    },
    function(res, next) {
      rpc1.listUnspent(next);
    },
    function(res, next) {
      rpc1.dumpPrivKey(res.result[0].address, function(err, result) {
        if (err) {
          return next(err);
        }
        next(null, res.result[0], result.result);
      });
    },
    function(unspent, key, next) {
      startingAddr = unspent.address;
      var utxo = { txId: unspent.txid, address: startingAddr, satoshis: unspent.amount * 1e8, script: unspent.scriptPubKey, outputIndex: unspent.vout };
      startingTx = buildInitialTx(utxo, key, next);
      rpc1.sendRawTransaction(startingTx.uncheckedSerialize(), next);
    },
    function(res, next) {
      console.log('generated: ' + outputKeys.length + ' utxos.');
      blocksGenerated += 6;
      rpc1.generate(6, next);
    },
    function(res, next) {
      // send it all back
      var txs = buildReturnTxs();
      var txCount = 0;
      async.eachSeries(txs, function(tx, next) {
        if (++txCount % 100 === 0) {
          console.log('sent: ', txCount, ' txs');
        }
        rpc1.sendRawTransaction(tx.uncheckedSerialize(), next);
      }, next);
    },
    function(next) {
      blocksGenerated += 6;
      rpc1.generate(6, next);
    }
  ], function(err) {

    if (err) {
      return callback(err);
    }

    callback();
  });
};

var startBitcore = function(callback) {

  rimraf(botcoreDataDir, function(err) {

    if(err) {
      return callback(err);
    }

    mkdirp(botcoreDataDir, function(err) {

      if(err) {
        return callback(err);
      }

      fs.writeFileSync(botcore.configFile.file, JSON.stringify(botcore.configFile.conf));

      var args = botcore.args;
      botcore.process = spawn(botcore.exec, args, botcore.opts);

      botcore.process.stdout.on('data', function(data) {

        if (debug) {
          process.stdout.write(data.toString());
        }

      });

      botcore.process.stderr.on('data', function(data) {

        if (debug) {
          process.stderr.write(data.toString());
        }

      });


      var httpOpts = {
        hostname: 'localhost',
        port: 53001,
        path: '/api/status',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      };

      async.retry({ interval: 1000, times: 100 }, function(next) {
        request(httpOpts, function(err, data) {
          if (err) {
            return next(err);
          }
          if (data.info.blocks < blocksGenerated) {
            return next(data);
          }
          next();
        });
      }, callback);

    });

  });


};


describe('Address Performance', function() {

  this.timeout(80000);

  before(function(done) {

    async.series([
      function(next) {
        startBitcoind(botcoinDataDirs.length, next);
      },
      function(next) {
        buildInitialChain(next);
      },
      function(next) {
        startBitcore(next);
      }
    ], done);

  });

  after(function(done) {
    shutdownBitcore(function() {
      shutdownBitcoind(done);
    });
  });


  it('should get address info correctly: /addr/:addr', function(done) {

    var httpOpts = {
      hostname: 'localhost',
      port: 53001,
      path: '/api/addr/' + startingAddr,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };


    async.timesSeries(1, function(n, next) {

      var startTime = process.hrtime();
      request(httpOpts, function(err) {

        if (err) {
          return done(err);
        }

        var endTime = process.hrtime(startTime);
        // under 1 sec?
        expect(endTime[0]).to.equal(0);
        next();

      });
    }, done);

  });

});


