// ==UserScript==
// @name         Homophone Explorer
// @namespace    com.konatopic.hpx
// @version      0.6.2b
// @description  Finds Japanese homophones on each vocabulary page on Wanikani.com
// @author       Konatopic
// @grant        GM_setValue
// @grant        GM_getValue
// @include      /^http(s)?://www\.wanikani\.com/vocabulary//
// @include      /^http(s)?://www\.wanikani\.com/level/[0-9]+/vocabulary//

// ==/UserScript==

// TODOs #########################################################
// support for lesson and review pages
// support for free accounts - check for {error}

// @include      /^http(s)?://www\.wanikani\.com/lesson/session/
// @include      /^http(s)?://www\.wanikani\.com/review/session/
// =============================== CONSTANTS =================================== //
var MAX_LEVEL = 60; // as of this version
var KEY_NAMES = { // names of entries as stored by HPX in storage - best not to change these after first use
    API_KEY:'APIKey',
    DATA:'data',
    USER_SETTINGS:'userSettings',
    LAST_UPDATED:'lastUpdated'
};
var SETTINGS_URL = 'https://www.wanikani.com/account';
var API_VERSION = "v1.4"; // built with version 1.4
var API_REQUEST_TEMPLATE = {
    VOCAB_LIST:'https://www.wanikani.com/api/{VERSION_NUMBER}/user/{USER_API_KEY}/vocabulary/{levels}'
};

// =============================== GLOBALS ====================================== //

var minUpdateInterval = 30; // minimum time between each automatic refresh in minutes
var lastUpdated;

// Some common names for the API Key variable defined some other script authors
var commonAPIKeyNames = ['apiKey'];

var hpx, // app-controller
    ui; // ui-controller

// =============================== FUNCTIONS ==================================== //
// Wanikani uses jQuery -- might as well take advantage of it
// Check for it.
(function checkJQuery(){
    if(typeof jQuery !== 'undefined') {
        (function(){
            hpx = new HPX(); // Entry point
        })();
    } else {
        setTimeout(function(){checkJQuery();},100);
    }
})();

// App controller
function HPX(){
    console.log('HPX initializing; Using jQuery version: ' + jQuery.fn.jquery + '. Caution: minified library may be incomplete');

    var APIKey,
        updating = false; // if this instance is updating

    var vocabDB, // from API_REQUEST_TEMPLATE.VOCAB_LIST
        requestedLevels;

    var comparisonVocab,
        comparisonReadings = [];

    var userInformation,
        vocabList;

    /* eg.,
    [0]{reading: 'あたり', vocabs:[[0]{name:"辺り",meaning:"area"... }]}
     */
    var homophones = [];

    // Clean up if user navigates away
    window.onbeforeunload = function(e){
        if(updating){
            setUpdatingFlag(false);
        }
    };

    // Load previous data if available
    loadDataFromLocal();

    // set up to listen for a new comparison vocab
    $(document).on("HPX:vocabUpdate",function(e,data){
        if(data && data.exists){
            comparisonVocab = data.comparisonVocab;
            createHomophoneList();
            ui.displayHomophones(homophones);
        }
        return false;
    });

    // Setup UI
    if($(location).attr('href').search(/^http(s)?:\/\/www\.wanikani\.com\/lesson\/session/) === 0 ||
       $(location).attr('href').search(/^http(s)?:\/\/www\.wanikani\.com\/lesson\/session/) === 0){
        ui = new UISessionPage();
    } else {
        ui = new UIPage();
    }

    ui.setStatus('INIT');

    // Let's look for the API Key
    findAPIKey(function(key){
        ui.setStatus('SEARCHING_FOR_KEY');
        if(typeof key === 'string'){
            // returned valid key
            APIKey = key;
            autoUpdate(); // only call function once!!

            ui.setStatus('IDLE');
        } else {
            console.log('Cannot find API Key anywhere. Please manually enter your by executing "localStorage.setItem(\''+
                        commonAPIKeyNames[0] +
                        '\', API_KEY);" in your developer console while on any wanikani.com page, where API_KEY is your 32 character API Key. Please report this to the developer.');
            ui.setStatus('SEARCH_FOR_KEY_FAILED');
        }
    });

    // schedules updates
    function autoUpdate(){

        var _lastUpdated = getLastUpdated(),
            timeSinceUpdate,
            timeUntilUpdate,
            randomTime;

        // add Math.random time to the scheduled update - javascript Chrome and Firefox extensions are probably single threaded but just to make sure
        // this is so that when more than one injected tab is open, they do not all update at the same time
        randomTime = Math.random() * 10000; // U(0,lim->10) seconds

        // set these two variables first
        if(typeof _lastUpdated === 'number'){
            timeSinceUpdate = new Date().getTime() - _lastUpdated;
            timeUntilUpdate = minUpdateInterval * 60 * 1000 - timeSinceUpdate + randomTime;
        }

        // only allow server updates on active tab
        if (pageIsHidden()){
            if(typeof _lastUpdated === 'number'){
                if(timeSinceUpdate < minUpdateInterval * 60 * 1000 && timeSinceUpdate >= 0){
                    localCreateAndDisplay(); // but do allow it to do a local update
                    console.log('Scheduled autoUpdate in '+Math.floor(timeUntilUpdate/60000)+' minutes, ' + timeUntilUpdate%60000/1000+' seconds.');
                    return setTimeout(function(){autoUpdate();},timeUntilUpdate); // and schedule an autoupdate as if it were an active tab
                }
            }
            console.log('Scheduled autoUpdate in 3 seconds.');
            return setTimeout(function(){autoUpdate();},3000); // try again in 3 seconds
        }

        // else in the active tab, schedule is a server update
        if(typeof _lastUpdated === 'number'){
            if(timeSinceUpdate > minUpdateInterval * 60 * 1000){
                // time for an update
                update();
            } else {
                if(timeUntilUpdate > 2147483647){
                    // some funny business huh? - the user probably doesn't want to stick around for 24.8 days for page to update
                    update();
                } else {
                    // schedule update
                    console.log('Scheduled autoUpdate in '+Math.floor(timeUntilUpdate/60000)+' minutes, ' + timeUntilUpdate%60000/1000+' seconds.');
                    setTimeout(function(){autoUpdate();},timeUntilUpdate);

                    // reload from cache because another instance of HPX could have updated the cache
                    localCreateAndDisplay();
                }
            }
        } else {

            // first run
            update();

        }

        // updates from server immediately and sets up autoUpdate()
        function update(){

            // It turns out this doesn't prevent multiple tabs from updating simultaneously if they load in close succession
            if(!isUpdating()){
                setUpdatingFlag(true);
            }else{
                // try again in 3 seconds
                setTimeout(function(){autoUpdate();},3000);
                ui.setStatus('UPDATING_OTHER_INSTANCE');
                console.log("Update queued. Retrying in 3 seconds");
                return;
            }

            ui.setStatus('UPDATING');

            loadListFromServer(function(success,data){

                setUpdatingFlag(false);

                if(success){

                    userInformation = data.user_information;
                    vocabList = data.requested_information;

                    console.log('Updated cache');

                    // update lastUpdated
                    lastUpdated = new Date().getTime();

                    // schedule next update
                    autoUpdate();

                    ui.setStatus('IDLE');
                } else {
                    console.log(data);
                    console.log('Problem connecting to server. Retrying in 3 seconds');
                    // schedule next update in 3 seconds
                    setTimeout(function(){autoUpdate();},3000);

                    ui.setStatus('CONNECTION_ERROR');
                }

            });

        }

        // checks sessionStorage for KEY_NAMES.UPDATING for updating status. Useful when more than one injected tab is open
        function isUpdating(){
            var res = sessionStorage.getItem('HPX');
            return (res !== null && JSON.parse(res).updating) ? true : false; // return updating status or false during first run
        }

    }

    // Sets HPX.updating flag in sessionStorage to prevent other HPX instances from updating
    function setUpdatingFlag(_updating){
        updating = _updating;
        sessionStorage.setItem('HPX',JSON.stringify({updating:_updating}));
    }

    function localCreateAndDisplay(){
        loadDataFromLocal();
        createHomophoneList();
        ui.displayHomophones(homophones);
    }

    // returns lastUpdated from GM_getValue
    function getLastUpdated(){
        var _lastUpdated = GM_getValue(KEY_NAMES.LAST_UPDATED);
        return (typeof _lastUpdated !== 'undefined' ? _lastUpdated:undefined); // return time lastUpdated or undefined during first run
    }



    // finds the reading for the current vocab - don't really trust the reading on the page - the layout could've been altered by other scripts
    function getComparisonReadings(){
        for (var i = 0;i < vocabList.length; i++){
            if(vocabList[i].character === comparisonVocab){
                comparisonReadings = splitReadings(vocabList[i].kana);
                console.log('Found ' + comparisonReadings.length + ' comparison readings found for ' + comparisonVocab);
                return;
            }
        }

        console.log('No comparison readings found for ' + comparisonVocab);
    }

    function createHomophoneList(){

        console.log('Creating homophones list using comparator: ' + comparisonVocab);

        var currentReadings = [];

        if(typeof comparisonVocab === 'undefined'){
            homophones = [];
            return false;
        }

        getComparisonReadings();

        // prepare homophones array
        for (var k = 0; k < comparisonReadings.length; k++){
            homophones[k] = {
                reading:comparisonReadings[k],
                vocabs:[]
            };
        }

        // look through entire vocabList to find matching readings
        for (var vocabIndex = 0; vocabIndex < vocabList.length; vocabIndex++){
            currentReadings = splitReadings(vocabList[vocabIndex].kana);

            // make separate list for each reading - most of the time there will only be one
            for (var comparisonIndex = 0; comparisonIndex < comparisonReadings.length; comparisonIndex++){

                // compare all comparison readings with each reading of the current vocab
                for (var i = 0; i < currentReadings.length; i++){
                    if(currentReadings[i] === comparisonReadings[comparisonIndex]){
                        // found one
                        console.log('Found homophone: ' + vocabList[vocabIndex].character);
                        homophones[comparisonIndex].vocabs.push(vocabList[vocabIndex]);
                    }
                }
            }
        }

        // clean up - remove the comparison vocab from the homophone list - probably faster this way
        for (var readingIndex = 0; readingIndex < homophones.length; readingIndex++){
            for (var h = 0; h < homophones[readingIndex].vocabs.length; h++){
                if(homophones[readingIndex].vocabs[h].character === comparisonVocab){
                    homophones[readingIndex].vocabs.splice(h,1);
                    h--;
                }
            }

            // remove reading from homophones list if it does not contain any homophones
            if(homophones[readingIndex].vocabs.length < 1){
                homophones.splice(readingIndex,1);
                readingIndex--;
            }
        }
    }

    // update data and class variables from cache
    // returns true if available, else false
    function loadDataFromLocal(){
        var _lastUpdated, _data;
        var obj = {};

        _lastUpdated = getLastUpdated();
        _data = GM_getValue(KEY_NAMES.DATA);

        /* jshint eqnull:true */
        if(_data == null || _lastUpdated == null){

            return false;
        } else {

            lastUpdated = _lastUpdated; // global variable
            userInformation = JSON.parse(_data).user_information; // hpx variable
            vocabList = JSON.parse(_data).requested_information; // hpx variable

            console.log("Loading data from cache");
            return true;
        }
        /* jshint eqnull:false */
    }

    // get json using API; also saves it in GM_setValue
    // param function(bool success, object data) callback, bool forceRefresh
    // ** note getting all levels at once causes server errors - need to split up the request
    function loadListFromServer(callback){

        var LEVELS_PER_SET = 15;
        var levels_per_set;

        var level = 1;
        var setIndex = 0;
        var totalSetCount;

        var dataSets = {};
        var jsonData;
        var jsonDataValid = true;
        var responsesReceived = 0;

        var callbackSent = false;

        // speed things up the first time this program is run - just so the user knows what's up
        if(typeof lastUpdated === 'undefined'){
            levels_per_set = 5;
            console.log('First time user detected. Please rest assured that after first run, HPX will no longer be making large quantites of API requests.');
        } else {
            levels_per_set = LEVELS_PER_SET;
        }

        totalSetCount = Math.ceil(MAX_LEVEL/levels_per_set);

        while (level <= MAX_LEVEL){

            var levels = '';
            var urlBuild = API_REQUEST_TEMPLATE.VOCAB_LIST;

            // build a levels string for the {levels} part of the request
            // splitting each set into levels_per_set levels
            for (var i = 0; i < levels_per_set && level <= MAX_LEVEL; level++, i++){
                levels += level;
                // add a ',' after every level except for the last one
                if(level !== MAX_LEVEL && i + 1 !== levels_per_set){
                    levels += ',';
                }
            }

            urlBuild = urlBuild.replace('{VERSION_NUMBER}',API_VERSION);
            urlBuild = urlBuild.replace('{USER_API_KEY}',APIKey);
            urlBuild = urlBuild.replace('{levels}',levels);

            console.log(urlBuild);

            (function(setID){
                $.ajax({
                    method:'GET',
                    url:urlBuild,
                    dataType:'json'
                }).done(function(data,status,xhr){
                    buildList(setID, true, data);
                }).fail(function(xhr){
                    buildList(setID, false, xhr);
                });
            })(setIndex);

            setIndex++;

        }

        // callback function from ajax requests - builds whole json file from multiple requests
        // calls back when all requests have called back, in success or failure
        // param bool success
        function buildList(setID,success,data){
            if(success){console.log('Data Set "'+setID+'" returned '+success);}

            responsesReceived++;

            if(success){
                // check if the setID is already in dataSets and that the build has not already received a failure
                if(!dataSets.hasOwnProperty(setID.toString()) && jsonDataValid){
                    dataSets[setID.toString()] = data;
                } else {
                    // somehow got a duplicate record - failure!!
                    jsonDataValid = false;
                    jsonData = 'Duplicate record ' + setID.toString();
                }
            } else {
                // fail response
                jsonDataValid = false;
                jsonData = data;
            }


            // check if all responses have been received
            if (responsesReceived >= totalSetCount){

                // consolidate dataSet into jsonData if no failure detected - data will be defined with xhr object or string if failed
                if(jsonDataValid){
                    // copy first set **note that this process is not a true cloning process - copy by reference only

                    jsonData = dataSets['0'];
                    var setIndex = 1;

                    for (var i = 1;i < totalSetCount; i++){
                        // check that the parts come from the correct user
                        if(dataSets[i.toString()].user_information.username === jsonData.user_information.username){
                            // merge requested_information array
                            jsonData.requested_information = jsonData.requested_information.concat(dataSets[i.toString()].requested_information);
                        } else {
                            jsonData = 'User mismatch. Expected ' + jsonData.user_information.username + '. Got ' + dataSets[i.toString()].user_information.username;
                            jsonDataValid = false;
                            break;
                        }
                    }

                }

                // save if successful
                if(jsonDataValid){
                    saveJson(jsonData);
                }

                // consolidated - now callback, whether it was successful or not
                callback(jsonDataValid,jsonData);

            }
        }

        function saveJson(jsonData){
            console.log('Saving json');
            GM_setValue (KEY_NAMES.DATA, JSON.stringify(jsonData));
            GM_setValue (KEY_NAMES.LAST_UPDATED, new Date().getTime());
        }

    }

    // split kana readings into arrays
    function splitReadings(readings){
        return readings.replace(/ /g,'').split(',');
    }

}

// User interface controller
function UIPage(){

    var elements = {}; // jQuery object DOM elements

    var lastViewUpdate = new Date().getTime();
    var timeoutID;

    var currentStatus;
    this.statuses = {
        INIT:function(){
            getComparisonVocab();
            return 'Initiatizing';
        },
        IDLE:function(){
            var time,days,hours,mins,secs;
            var strTime = 'Last updated: ';
            if(typeof lastUpdated === 'undefined' || lastUpdated < 1){
                strTime += 'Never';
            } else {

                time = new Date().getTime() - lastUpdated;
                days = Math.floor(time/(1000*60*60*24));

                if(days > 0){
                    strTime+= days + ' day(s), ';
                }

                time %= 1000*60*60*24;
                hours = Math.floor(time/(1000*60*60));

                if(hours > 0){
                    strTime+= hours + ' hour(s), ';
                }

                time %= 1000*60*60;
                mins = Math.floor(time/(1000*60));

                if(mins > 0){
                    strTime+= mins + ' minute(s) and ';
                }

                time %= 1000*60;
                secs = Math.floor(time/1000);

                strTime+= secs + ' second(s) ago ';

            }
            return strTime;
        },
        SEARCHING_FOR_KEY: 'Looking for your API Key.',
        SEARCH_FOR_KEY_FAILED:'Cannot find your API Key. Please try again later.',
        CONNECTION_ERROR: function(){
            setTimeout(function(){this.setStatus('IDLE');},2000); // go back to idle after 2 seconds of displaying error message
            return 'Connection error... Retrying momentarily';
        },
        UPDATING: 'Updating cache with Wanikani servers. Please stay on the page...', // API Servers
        UPDATING_OTHER_INSTANCE: 'Updating cache on another instance.'
    };

    // build UI layout hierarchy
    // using Wanikani's .kotaba-table-list to display the vocab
    elements.hpxSection = $('<section>',{id:'hpx-ui',class:'kotoba-table-list'});
    $('.vocabulary-reading').after(elements.hpxSection);

    // section title/heading
    elements.heading = $('<h2>',{text:'Homophones'});

    // info h4
    elements.info = $('<h4>',{class:'small-caps',text:''});

    // ul
    elements.ul = $('<ul>',{class:'multi-character-grid'});

    // display p when no homophones found
    elements.noHomophones = $('<p>',{text:'No homophones founds'});

    elements.hpxSection
        .append(elements.heading)
        .append(elements.info)
        .append(elements.ul);

    // build the list layout
    this.displayHomophones = function(homophones){

        var t = {};

        // empty ul wrapper from previous renders
        elements.ul.empty();

        // add "no homophones found" if there were no homophones found
        if (homophones.length < 1){
            elements.ul.append(elements.noHomophones);
        }

        for (var readingsIndex = 0; readingsIndex < homophones.length; readingsIndex++){

            for (var i = 0; i < homophones[readingsIndex].vocabs.length; i++){

                // time to create that item - has this structure
                /*
                * <li class="character-item {EXTRA_CLASSES}" id="vocabulary-{CHARACTER}">
				*	<span lang="ja" class="item-badge"></span>
				*	<a href="/vocabulary/{URLENCODED_CHARACTER}">
				*		<span class="character" lang="ja">{CHARACTER}</span>
				*		<ul>
				*			<li lang="ja">{READING}</li>
				*			<li>{MEANING}</li>
				*		</ul>
				*	</a>
				* </li>
                */

                t.liWrapper = $('<li>',{class:'character-item', id:'vocabulary-' + homophones[readingsIndex].vocabs[i].character});

                // set {EXTRA_CLASSES}
                if(homophones[readingsIndex].vocabs[i].user_specific === null){
                    // locked
                    t.liWrapper.addClass('locked');
                } else if (homophones[readingsIndex].vocabs[i].user_specific.srs === 'burned') {
                    // burned
                    t.liWrapper.addClass('burned');
                }

                t.spanItemBadge = $('<span>',{class:'item-badge', lang:'ja'});
                t.anchor = $('<a>',{href:'/vocabulary/'+encodeURIComponent(homophones[readingsIndex].vocabs[i].character)});
                t.spanCharacter = $('<span>',{class:'character', lang:'ja', text:homophones[readingsIndex].vocabs[i].character});
                t.ulWrapper = $('<ul>');
                t.liReading = $('<li>',{lang:'ja', text:homophones[readingsIndex].vocabs[i].kana});
                t.liMeaning = $('<li>',{text:homophones[readingsIndex].vocabs[i].meaning});

                // append these elements appropriately
                t.liWrapper.append(t.spanItemBadge)
                    .append(t.anchor);

                t.anchor.append(t.spanCharacter)
                    .append(t.ulWrapper);

                t.ulWrapper.append(t.liReading)
                    .append(t.liMeaning);

                elements.ul.append(t.liWrapper);

            }

            // add a separator
            if (readingsIndex < homophones.length - 1){
                elements.ul.append($('<hr>'));
            }
        }
    };

    // public function that allows the view to be set
    // calls updateView() which updates the status text
    this.setStatus = function(state){

        var thisContext = this;

        console.log(state);
        if(thisContext.statuses.hasOwnProperty(state)){
            currentStatus = state;
            updateView();
        }

        function updateView(){
            var res;

            if(typeof thisContext.statuses[currentStatus] === 'function'){
                res = thisContext.statuses[currentStatus]();
            } else {
                res = thisContext.statuses[currentStatus];
            }

            if(typeof timeoutID != 'undefined'){
                clearTimeout(timeoutID);
                elements.info.text(res);
            }
            timeoutID = setTimeout(function(){updateView();},1000);
        }

    };

    // get the vocab of the current page from url
    function getComparisonVocab(){
        var comparisonVocab,
            currentUrl = $(location).attr('href');

        // create jQuery object with <a> DOM
        var a = $('<a>',{href:currentUrl})[0];

        // extract pathname from the url
        var pathname = a.pathname;

        // at this stage, pathname could be "/vocabulary/{vocab}" or "/vocabulary/{vocab}/" or "/level/[0-9]+/vocabulary/{vocab}" or "/level/[0-9]+/vocabulary/{vocab}/"
        // remove "/vocabulary/" first then any trailing"/"
        pathname = pathname.replace(/^.*\/vocabulary\//i,'');
        pathname = pathname.replace(/\//,'');

        // decode
        comparisonVocab = decodeURIComponent(pathname);
        console.log('Comparison vocab detected as ' + comparisonVocab);

        // trigger new HPX:vocabUpdate event
        $(document).trigger('HPX:vocabUpdate',{
            exists: true,
            comparisonVocab: comparisonVocab
        });
    }

}

function UISessionPage(){

    var comparisonVocab;

    // hook jQuery.fn.show()
    $.fn._show_hpx = $.fn.show;
    $.fn.show = function(a,b,c){
        var res = $.fn._show_hpx.call(this,a,b,c);

        // detect when Wanikani has loaded additional item information
        // ("#all-info").show() seems to correspond with this.
        // Cannot just hook show() of just one instance as jQuery creates a new jQuery every time it's called and doesn't reuse jQuery objects as I had first thought
        if(this[0].id === "all-info"){

        }

        return res;
    };
}

// Attempts to find API Key in GM_getValue, localStorage and wanikani.com in that order
// bool forceRemote - flag to skip local search
// function(key) callback - callback function after ajax function calls back
//    str key on success, else jqXhr object on failure
function findAPIKey(callback,forceRemote){

    var key;
    var keyRegex = /^[0-9a-f]{32}$/i;

    // default value of forceRemote is false
    if (typeof forceRemote !== 'undefined' || !forceRemote){

        // Look for the key in userscript DB
        key = GM_getValue(KEY_NAMES.API_KEY);
        if(typeof key == 'undefined'){
            console.log('Cannot find key from GM_getValue');
            // Not in userscript DB
            // Look in localstorage - helpful if API Key is defined by other scripts
            var validKeyFound = false;
            for (var i = 0; i < commonAPIKeyNames.length; i++){

                key = localStorage.getItem(commonAPIKeyNames[i]);

                // Check if key exists and fits regex
                if(isValidKey(key)){

                    //Key from localStorage valid
                    validKeyFound = true;
                    break;

                } // Else keep looping
            }

            if (validKeyFound){
                console.log('Found key in localStorage: ' + key);
                saveKey(key);
                return callback(key);
            }
        } else {
            console.log('Found key in GM_getValue: ' + key);
            return callback(key);
        }
    }

    // find key on Wanikani settings page by way of AJAX
    $.ajax({
        method: 'GET',
        url: SETTINGS_URL,
        dataType: 'html'
    }).done(function(data,status,xhr){
        // Received successful response from server
        // Parse responseText as HTML then create jQuery object
        var page = $($.parseHTML(data));

        // Find key from input box that is the child of a <div> that has another child with #api-button
        key = page.find('#api-button').parent().find('input')[0].value;
        if(isValidKey(key)){
            console.log('Found it from AJAX: ' + key);

            saveKey(key);
            callback(key);
        }
    }).fail( function(xhr){
        // Did not receive successful response
        console.log(xhr); // RESPOND TO THIS FAILED RESPONSE  #######################################
        callback(xhr);
    });

    function saveKey(validKey){
        GM_setValue(KEY_NAMES.API_KEY,validKey);
        console.log('Key saved in GM_setValue');
    }

    function isValidKey(tryKey){
        // key would be null if not set in localStorage
        return (typeof tryKey !== 'undefined' && tryKey !== null && tryKey.search(keyRegex) != -1);
    }

}

// for testing only
function GM_clearValues(){
    var keys = GM_listValues();
    for (var i = 0; i < keys.length; i++){
        GM_deleteValue(keys[i]);
        console.log('Deleted ' + keys[i]);
    }
}

// http://www.html5rocks.com/en/tutorials/pagevisibility/intro/
function pageIsHidden(){
    var prefixes = ['webkit','moz','ms','o'];
    var property;

    // if 'hidden' is natively supported just return it
    if ('hidden' in document){
        property = 'hidden';
    } else {
        // otherwise loop over all the known prefixes until we find one
        for (var i = 0; i < prefixes.length; i++){
            if ((prefixes[i] + 'Hidden') in document){
                property = prefixes[i] + 'Hidden';
            }
        }
    }
    // otherwise hidden is not supported

    return (typeof document[property] !== 'undefined' ? document[property] : false);

}