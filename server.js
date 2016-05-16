// catroom.js
/*
	requires:
		npm install --save ws		https://github.com/websockets/ws

	You create a room by encrypting a string generated by the client.
	This string is sent to the server. This string is called the FISH.
	The server generates a random string to act as the new room's id.
	The new room is joined with:
		GET /room?id=<room id string> HTTP/1.x

	When someone connects to an existing room, they are sent the standard page.
	They are also sent the room's FISH in the <script> tag as a variable.
	They enter a password, and do AES.decrypt to the FISH.
	If it fails, leave the page.
	If it succeeds:
		Open a secure websocket connection to the server.
		The server and client will only exchange JSON encoded objects.
		Client must send a packet "CONNECT" with their encrypted username.
		Server will send a packet type "USERS" with global IDs mapped to their encrypted usernames.
		Server will periodically send packet type "PING".
		The client will respond with type "PONG" and the same packet data in the PING packet.

	If another user joins, server will send "JOIN" with the global ID and encrypted username of the new cat.
	If another user leaves, server will send "DROP" and the global ID of the departed cat.
	To send a message, a user sends "MSG" with the message encrypted.
	The server tags the object with their global ID, and relays it.
	This "MSG" packet is then received, decrypted, and displayed.
*/

var WebSocketServer = require('ws').Server;

const https = require('https');
const fs = require('fs');
const urllib = require('url');
const querystring = require('querystring');

const https_options = {
	key: fs.readFileSync('/home/saucecode/.ssh/testkey.pem'),
	cert: fs.readFileSync('/home/saucecode/.ssh/testcert.pem')
};

const resources = {
	index:fs.readFileSync('index.html', 'utf-8'),
	roomtemplate:fs.readFileSync('chatroom.html', 'utf-8'),
	sha512:fs.readFileSync('crypto-js/sha512.js'),
	aes:fs.readFileSync('crypto-js/aes.js'),
	client_js:fs.readFileSync('client.js')
};

rooms = {};
PING_INTERVAL = 10000; // interval between pings

function randomString(len){
	var s = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	return Array(len).join().split(',').map(function() { return s.charAt(Math.floor(Math.random() * s.length)); }).join('');
}

var httpsServer = https.createServer(https_options, (req,res) => {

	url = urllib.parse(req.url);
	console.log("Got request for " + url.href);

	if( url.pathname == "/" ){
		res.writeHead(200);
		res.end(resources.index);

	}else if( url.pathname == "/room" ){
		var query = querystring.parse(url.query);
		if( query.id == null
			|| query.id == ""
			|| rooms[query.id] == null){
			res.writeHead(200);
			res.end("Invalid room ID " + JSON.stringify(query) + " " + query.id);
			return;
		}

		res.writeHead(200);
		res.end(resources.roomtemplate.replace("$fish", rooms[query.id].fish));


	}else if( url.pathname == "/newroom/" ){
		if(req.method != "POST"){
			res.writeHead(405);
			res.end("Method not supported.");
			return;
		}

		var body = "";

		req.on("data", function(data){
			body += data.toString();
		});

		req.on("end", function(){
			// Parse POST data
			var formdata = querystring.parse(body);

			// Check room_password is existing and valid.
			if( formdata.room_password == null || formdata.room_password.length < 64 ){
				res.writeHead(200);
				res.end("Invalid form parameters.");
				return;
			}

			// Generate unique random room id
			var roomname = randomString(16);
			while( rooms[roomname] != null ){ roomname = randomString(16); }

			// Create room
			rooms[roomname] = {users:{}};
			rooms[roomname].fish = formdata.room_password;

			res.writeHead(200, {"Content-Type":"text/html"});
			res.end("got: " + formdata.room_password + "<br/>\nCreated room: <a href='/room?id=" + roomname + "'>goto room</a>");
		});


	}else if( url.pathname == "/res/sha512.js" ){
		res.writeHead(200, {"Content-Type":"text/javascript"});
		res.end(resources.sha512);

	}else if( url.pathname == "/res/aes.js" ){
		res.writeHead(200, {"Content-Type":"text/javascript"});
		res.end(resources.aes);

	else if( url.pathname == "res/client.js" ){
		res.writeHead(200, {"Content-Type":"text/javascript"});
		res.end(resources.client_js);

	}else{
		res.writeHead(404);
		res.end("Resource not found.\n");
	}

});

wss = new WebSocketServer({server:httpsServer, path: "/chat"});
wss.on("connection", (connection) => {

	connection.on("message", (message) => {
		var request;
		try {
			request = JSON.parse(message);
		} catch(err) {
			if( err instanceof SyntaxError )
				console.log("Got an invalid chat request");

			console.log(err);
			return;
		}

		switch(request.type){
			case "CONNECT":
				// check room exists
				if( rooms[request.roomid] == null ){
					console.log("connect attempt to non-existant room: " + request.roomid);
					var packet_error = {
						type:"ERROR",
						id:"connecterror",
						data:"this room does not exist",
						die:true
					};
					connection.send(JSON.stringify(packet_error));
					connection.close();
					break;
				}

				// check gid doesn't already exist
				var globalID = randomString(7);
				while( rooms[request.roomid].users[globalID] != null ) globalID = randomString(7);

				console.log("got connect request:");
				console.log("ROOM: " + request.roomid);
				console.log("NAME: " + request.data);
				console.log("GID:  " + globalID);

				//Generate JOIN packet and send to connected users
				var packet_join = { type:"JOIN", id:globalID, name:request.data };
				for(var user in rooms[request.roomid].users){
					rooms[request.roomid].users[user].connection.send(JSON.stringify(packet_join));
				}

				// Put new user into room's "users" object
				connection.roomid = request.roomid;
				connection.globalID = globalID;
				rooms[request.roomid].users[globalID] = {
					name: request.data,
					id: globalID,
					connection: connection
				};

				// Generate a USERS packet and send to connecting user
				var packet_users = { type:"USERS", users:{} };
				for( var key in rooms[request.roomid].users ){
					var user = rooms[request.roomid].users[key];
					packet_users.users[user.id] = {
						name:user.name,
						id:user.id
					};
				}

				// Start pinging the new kid
				rooms[request.roomid].users[globalID].pingInterval = setInterval(pingUser, PING_INTERVAL, request.roomid, globalID);
				pingUser(request.roomid, globalID);

				connection.send(JSON.stringify(packet_users));
				break;

			case "MSG":
				console.log("Received message: " + request.data);
				request.id = connection.globalID; // tag with sender's ID
				for(var userid in rooms[connection.roomid].users){
					rooms[connection.roomid].users[userid].connection.send(JSON.stringify(request));
				}
				break;

			case "PONG":
				var user = rooms[connection.roomid].users[connection.globalID];
				if(request.data != user.ping_string){
					var error_packet = {type:"ERROR", id:"pingerror", data:"incorrect response", die:false};
					user.connection.send(JSON.stringify(error_packet));
				}
				break;
		}

	});

});

function pingUser(roomid, userid){
	var ping_packet = {type:"PING", data:randomString(6)};
	rooms[roomid].users[userid].connection.send(JSON.stringify(ping_packet));
	rooms[roomid].users[userid].ping_string = ping_packet.data;

	// TODO Check for disconnected users!
}

httpsServer.listen(25565);
