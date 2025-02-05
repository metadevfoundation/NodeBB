'use strict';

var async = require('async'),
	fs = require('fs'),
	path = require('path'),
	prompt = require('prompt'),
	winston = require('winston'),
	nconf = require('nconf'),
	utils = require('../public/src/utils.js'),

	DATABASES = {
		"redis": {
			"dependencies": ["redis@~0.10.1", "connect-redis@~2.0.0"]
		},
		"mongo": {
			"dependencies": ["mongodb@~2.0.0", "connect-mongo"]
		}
	};


var install = {},
	questions = {};

questions.main = [
	{
		name: 'url',
		description: 'URL used to access this NodeBB',
		'default':
			nconf.get('url') ||
			(nconf.get('base_url') ? (nconf.get('base_url') + (nconf.get('use_port') ? ':' + nconf.get('port') : '')) : null) ||	// backwards compatibility (remove for v0.7.0)
			'http://localhost:4567',
		pattern: /^http(?:s)?:\/\//,
		message: 'Base URL must begin with \'http://\' or \'https://\'',
	},
	{
		name: 'secret',
		description: 'Please enter a NodeBB secret',
		'default': nconf.get('secret') || utils.generateUUID()
	},
	{
		name: 'database',
		description: 'Which database to use',
		'default': nconf.get('database') || 'redis'
	}
];

questions.optional = [
	{
		name: 'port',
		default: nconf.get('port') || 4567
	}
];

function checkSetupFlag(next) {
	var	envSetupKeys = ['database'],
		setupVal;
	try {
		if (nconf.get('setup')) {
			setupVal = JSON.parse(nconf.get('setup'));
		}
	} catch (err) {
		setupVal = undefined;
	}

	if (setupVal && setupVal instanceof Object) {
		if (setupVal['admin:username'] && setupVal['admin:password'] && setupVal['admin:password:confirm'] && setupVal['admin:email']) {
			install.values = setupVal;
			next();
		} else {
			winston.error('Required values are missing for automated setup:');
			if (!setupVal['admin:username']) {
				winston.error('  admin:username');
			}
			if (!setupVal['admin:password']) {
				winston.error('  admin:password');
			}
			if (!setupVal['admin:password:confirm']) {
				winston.error('  admin:password:confirm');
			}
			if (!setupVal['admin:email']) {
				winston.error('  admin:email');
			}

			process.exit();
		}
	} else if (envSetupKeys.every(function(key) {
		return nconf.stores.env.store.hasOwnProperty(key);
	})) {
		install.values = envSetupKeys.reduce(function(config, key) {
			config[key] = nconf.stores.env.store[key];
			return config;
		}, {});

		next();
	} else {
		next();
	}
}

function checkCIFlag(next) {
	var	ciVals;
	try {
		ciVals = JSON.parse(nconf.get('ci'));
	} catch (e) {
		ciVals = undefined;
	}

	if (ciVals && ciVals instanceof Object) {
		if (ciVals.hasOwnProperty('host') && ciVals.hasOwnProperty('port') && ciVals.hasOwnProperty('database')) {
			install.ciVals = ciVals;
			next();
		} else {
			winston.error('Required values are missing for automated CI integration:');
			if (!ciVals.hasOwnProperty('host')) {
				winston.error('  host');
			}
			if (!ciVals.hasOwnProperty('port')) {
				winston.error('  port');
			}
			if (!ciVals.hasOwnProperty('database')) {
				winston.error('  database');
			}

			process.exit();
		}
	} else {
		next();
	}
}

function setupConfig(next) {
	var configureDatabases = require('../install/databases');

	// prompt prepends "prompt: " to questions, let's clear that.
	prompt.start();
	prompt.message = '';
	prompt.delimiter = '';
	prompt.colors = false;

	if (!install.values) {
		prompt.get(questions.main, function(err, config) {
			if (err) {
				process.stdout.write('\n\n');
				winston.warn('NodeBB setup ' + err.message);
				process.exit();
			}

			if (nconf.get('advanced')) {
				prompt.get({
					name: 'secondary_database',
					description: 'Select secondary database',
					'default': nconf.get('secondary_database') || 'none'
				}, function(err, dbConfig) {
					config.secondary_database = dbConfig.secondary_database;
					configureDatabases(err, config, DATABASES, function(err, config) {
						completeConfigSetup(err, config, next);
					});
				});
			} else {
				configureDatabases(err, config, DATABASES, function(err, config) {
					completeConfigSetup(err, config, next);
				});
			}
		});
	} else {
		// Use provided values, fall back to defaults
		var	config = {},
			redisQuestions = require('./database/redis').questions,
			mongoQuestions = require('./database/mongo').questions,
			question, x, numQ, allQuestions = questions.main.concat(questions.optional).concat(redisQuestions).concat(mongoQuestions);

		for(x=0,numQ=allQuestions.length;x<numQ;x++) {
			question = allQuestions[x];
			config[question.name] = install.values[question.name] || question['default'] || undefined;
		}

		configureDatabases(null, config, DATABASES, function(err, config) {
			completeConfigSetup(err, config, next);
		});
	}
}

function completeConfigSetup(err, config, next) {
	if (err) {
		return next(err);
	}

	// Add CI object
	if (install.ciVals) {
		config.test_database = {};
		for(var prop in install.ciVals) {
			if (install.ciVals.hasOwnProperty(prop)) {
				config.test_database[prop] = install.ciVals[prop];
			}
		}
	}

	install.save(config, function(err) {
		if (err) {
			return next(err);
		}

		setupDatabase(config, next);
	});
}

function setupDatabase(server_conf, next) {
	install.installDbDependencies(server_conf, function(err) {
		if (err) {
			return next(err);
		}

		require('./database').init(next);
	});
}

install.installDbDependencies = function(server_conf, next) {
	var	npm = require('npm'),
		packages = [];

	npm.load({}, function(err) {
		if (err) {
			return next(err);
		}

		npm.config.set('spin', false);

		packages = packages.concat(DATABASES[server_conf.database].dependencies);
		if (server_conf.secondary_database) {
			packages = packages.concat(DATABASES[server_conf.secondary_database].dependencies);
		}

		npm.commands.install(packages, next);
	});
};

function setupDefaultConfigs(next) {
	process.stdout.write('Populating database with default configs, if not already set...\n');
	var meta = require('./meta'),
		defaults = require(path.join(__dirname, '../', 'install/data/defaults.json'));

	async.each(Object.keys(defaults), function (key, next) {
		meta.configs.setOnEmpty(key, defaults[key], next);
	}, function (err) {
		if (err) {
			return next(err);
		}

		if (install.values) {
			async.parallel([
				async.apply(setIfPaired, 'social:twitter:key', 'social:twitter:secret'),
				async.apply(setIfPaired, 'social:google:id', 'social:google:secret'),
				async.apply(setIfPaired, 'social:facebook:app_id', 'social:facebook:secret')
			], function(err) {
				if (err) {
					return next(err);
				}
				meta.configs.init(next);
			});
		} else {
			meta.configs.init(next);
		}
	});
}

function setIfPaired(key1, key2, callback) {
	var meta = require('./meta');
	if (install.values[key1] && install.values[key2]) {
		async.parallel([
			async.apply(meta.configs.setOnEmpty, key1, install.values[key1]),
			async.apply(meta.configs.setOnEmpty, key2, install.values[key2])
		], callback);
	} else {
		callback();
	}
}

function enableDefaultTheme(next) {
	var	meta = require('./meta');

	meta.configs.get('theme:id', function(err, id) {
		if (err || id) {
			process.stdout.write('Previous theme detected, skipping enabling default theme\n');
			return next(err);
		}

		process.stdout.write('Enabling default theme: Lavender\n');
		meta.themes.set({
			type: 'local',
			id: 'nodebb-theme-lavender'
		}, next);
	});
}

function createAdministrator(next) {
	var Groups = require('./groups');
	Groups.getMemberCount('administrators', function (err, memberCount) {
		if (err) {
			return next(err);
		}
		if (memberCount > 0) {
			process.stdout.write('Administrator found, skipping Admin setup\n');
			next();
		} else {
			createAdmin(next);
		}
	});
}

function createAdmin(callback) {
	var User = require('./user'),
		Groups = require('./groups'),
		password;

	winston.warn('No administrators have been detected, running initial user setup\n');

	var questions = [{
			name: 'username',
			description: 'Administrator username',
			required: true,
			type: 'string'
		}, {
			name: 'email',
			description: 'Administrator email address',
			pattern: /.+@.+/,
			required: true
		}],
		passwordQuestions = [{
			name: 'password',
			description: 'Password',
			required: true,
			hidden: true,
			type: 'string'
		}, {
			name: 'password:confirm',
			description: 'Confirm Password',
			required: true,
			hidden: true,
			type: 'string'
		}],
		success = function(err, results) {
			if (!results) {
				return callback(new Error('aborted'));
			}

			if (results['password:confirm'] !== results.password) {
				winston.warn("Passwords did not match, please try again");
				return retryPassword(results);
			}

			async.waterfall([
				function(next) {
					User.create({username: results.username, password: results.password, email: results.email}, next);
				},
				function(uid, next) {
					Groups.join('administrators', uid, next);
				},
				function(next) {
					Groups.show('administrators', next);
				}
			], function(err) {
				if (err) {
					return callback(err);
				}
				callback(null, password ? results : undefined);
			});
		},
		retryPassword = function (originalResults) {
			// Ask only the password questions
			prompt.get(passwordQuestions, function (err, results) {
				if (!results) {
					return callback(new Error('aborted'));
				}

				// Update the original data with newly collected password
				originalResults.password = results.password;
				originalResults['password:confirm'] = results['password:confirm'];

				// Send back to success to handle
				success(err, originalResults);
			});
		};

	// Add the password questions
	questions = questions.concat(passwordQuestions);

	if (!install.values) {
		prompt.get(questions, success);
	} else {
		// If automated setup did not provide a user password, generate one, it will be shown to the user upon setup completion
		if (!install.values.hasOwnProperty('admin:password') && !nconf.get('admin:password')) {
			process.stdout.write('Password was not provided during automated setup, generating one...\n');
			password = utils.generateUUID().slice(0, 8);
		}

		var results = {
			username: install.values['admin:username'] || nconf.get('admin:username') || 'admin',
			email: install.values['admin:email'] || nconf.get('admin:email') || '',
			password: install.values['admin:password'] || nconf.get('admin:password') || password,
			'password:confirm': install.values['admin:password:confirm'] || nconf.get('admin:password') || password
		};

		success(null, results);
	}
}

function createCategories(next) {
	var Categories = require('./categories');

	Categories.getAllCategories(0, function (err, categoryData) {
		if (err) {
			return next(err);
		}

		if (Array.isArray(categoryData) && categoryData.length) {
			process.stdout.write('Categories OK. Found ' + categoryData.length + ' categories.\n');
			return next();
		}

		process.stdout.write('No categories found, populating instance with default categories\n');

		fs.readFile(path.join(__dirname, '../', 'install/data/categories.json'), function (err, default_categories) {
			if (err) {
				return next(err);
			}
			default_categories = JSON.parse(default_categories);

			async.eachSeries(default_categories, Categories.create, next);
		});
	});
}

function createMenuItems(next) {
	var db = require('./database');

	db.exists('navigation:enabled', function(err, exists) {
		if (err || exists) {
			return next(err);
		}
		var navigation = require('./navigation/admin'),
			data = require('../install/data/navigation.json');

		navigation.save(data, next);
	});
}

function createWelcomePost(next) {
	var db = require('./database'),
		Topics = require('./topics');

	async.parallel([
		function(next) {
			fs.readFile(path.join(__dirname, '../', 'install/data/welcome.md'), next);
		},
		function(next) {
			db.getObjectField('global', 'topicCount', next);
		}
	], function(err, results) {
		var content = results[0],
			numTopics = results[1];

		if (!parseInt(numTopics, 10)) {
			Topics.post({
				uid: 1,
				cid: 2,
				title: 'Welcome to your NodeBB!',
				content: content.toString()
			}, next);
		} else {
			next();
		}
	});
}

function enableDefaultPlugins(next) {
	var Plugins = require('./plugins');

	process.stdout.write('Enabling default plugins\n');

	var defaultEnabled = [
		'nodebb-plugin-composer-default',
		'nodebb-plugin-markdown',
		'nodebb-plugin-mentions',
		'nodebb-widget-essentials',
		'nodebb-rewards-essentials',
		'nodebb-plugin-soundpack-default',
		'nodebb-plugin-emoji-extended'
	];
	var	db = require('./database');
	var order = defaultEnabled.map(function(plugin, index) {
		return index;
	});
	db.sortedSetAdd('plugins:active', order, defaultEnabled, next);
}

function setCopyrightWidget(next) {
	var	db = require('./database');
	async.parallel({
		footerJSON: function(next) {
			fs.readFile(path.join(__dirname, '../', 'install/data/footer.json'), next);
		},
		footer: function(next) {
			db.getObjectField('widgets:global', 'footer', next);
		}
	}, function(err, results) {
		if (err) {
			return next(err);
		}

		if (!results.footer && results.footerJSON) {
			db.setObjectField('widgets:global', 'footer', results.footerJSON.toString(), next);
		} else {
			next();
		}
	});
}

install.setup = function (callback) {


	async.series([
		checkSetupFlag,
		checkCIFlag,
		setupConfig,
		setupDefaultConfigs,
		enableDefaultTheme,
		createCategories,
		createAdministrator,
		createMenuItems,
		createWelcomePost,
		enableDefaultPlugins,
		setCopyrightWidget,
		function (next) {
			var upgrade = require('./upgrade');
			upgrade.check(function(err, uptodate) {
				if (err) {
					return next(err);
				}
				if (!uptodate) { upgrade.upgrade(next); }
				else { next(); }
			});
		}
	], function (err, results) {
		if (err) {
			winston.warn('NodeBB Setup Aborted.\n ' + err.stack);
			process.exit();
		} else {
			var data = {};
			if (results[6]) {
				data.username = results[6].username;
				data.password = results[6].password;
			}

			callback(null, data);
		}
	});
};

install.save = function (server_conf, callback) {
	var	serverConfigPath = path.join(__dirname, '../config.json');

	if (nconf.get('config')) {
		serverConfigPath = path.resolve(__dirname, '../', nconf.get('config'));
	}

	fs.writeFile(serverConfigPath, JSON.stringify(server_conf, null, 4), function (err) {
		if (err) {
			winston.error('Error saving server configuration! ' + err.message);
			return callback(err);
		}

		process.stdout.write('Configuration Saved OK\n');

		nconf.file({
			file: path.join(__dirname, '..', 'config.json')
		});

		callback();
	});
};

module.exports = install;
